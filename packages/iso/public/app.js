const token = window.ISO_CONTROL_TOKEN;
const relayMode = token === null;
const canControl = window.ISO_CAN_CONTROL === true;
const elements = {
	campaignGoal: document.querySelector("#campaign-goal"),
	campaignStatus: document.querySelector("#campaign-status"),
	missionDetail: document.querySelector("#mission-detail"),
	generationLabel: document.querySelector("#generation-label"),
	controlHint: document.querySelector("#control-hint"),
	baselineScore: document.querySelector("#baseline-score"),
	championScore: document.querySelector("#champion-score"),
	metricLabel: document.querySelector("#metric-label"),
	championLabel: document.querySelector("#champion-label"),
	deltaScore: document.querySelector("#delta-score"),
	deltaLabel: document.querySelector("#delta-label"),
	confidenceLabel: document.querySelector("#confidence-label"),
	generationCount: document.querySelector("#generation-count"),
	generationDetail: document.querySelector("#generation-detail"),
	experimentCount: document.querySelector("#experiment-count"),
	experimentDetail: document.querySelector("#experiment-detail"),
	budgetSummary: document.querySelector("#budget-summary"),
	generationBudgetLabel: document.querySelector("#generation-budget-label"),
	experimentBudgetLabel: document.querySelector("#experiment-budget-label"),
	plateauBudgetLabel: document.querySelector("#plateau-budget-label"),
	generationProgress: document.querySelector("#generation-progress"),
	experimentProgress: document.querySelector("#experiment-progress"),
	plateauProgress: document.querySelector("#plateau-progress"),
	workerCount: document.querySelector("#worker-count"),
	workerList: document.querySelector("#worker-list"),
	experimentTable: document.querySelector("#experiment-table"),
	experimentEmpty: document.querySelector("#experiment-empty"),
	generationList: document.querySelector("#generation-list"),
	generationWindowNote: document.querySelector("#generation-window-note"),
	reflectionGeneration: document.querySelector("#reflection-generation"),
	reflectionSummary: document.querySelector("#reflection-summary"),
	lessonList: document.querySelector("#lesson-list"),
	deadEndList: document.querySelector("#dead-end-list"),
	nextFocusList: document.querySelector("#next-focus-list"),
	eventList: document.querySelector("#event-list"),
	ledgerWindowNote: document.querySelector("#ledger-window-note"),
	graph: document.querySelector("#idea-graph"),
	graphEmpty: document.querySelector("#graph-empty"),
	graphSummary: document.querySelector("#graph-summary"),
	lineageList: document.querySelector("#lineage-list"),
	guidanceSummary: document.querySelector("#guidance-summary"),
	guidanceList: document.querySelector("#guidance-list"),
	completionState: document.querySelector("#completion-state"),
	completionReport: document.querySelector("#completion-report"),
	startButton: document.querySelector("#start-button"),
	pauseButton: document.querySelector("#pause-button"),
	stopButton: document.querySelector("#stop-button"),
	campaignMessageForm: document.querySelector("#campaign-message-form"),
	campaignMessageInput: document.querySelector("#campaign-message-input"),
	campaignMessageSend: document.querySelector("#campaign-message-send"),
	evidenceWindowNote: document.querySelector("#evidence-window-note"),
	evaluatorDigest: document.querySelector("#evaluator-digest"),
	sourceCommit: document.querySelector("#source-commit"),
	runtimeProvenance: document.querySelector("#runtime-provenance"),
	selectionContract: document.querySelector("#selection-contract"),
	evaluationPlan: document.querySelector("#evaluation-plan"),
	controlBarrier: document.querySelector("#control-barrier"),
	toast: document.querySelector("#toast"),
	connectionLabel: document.querySelector("#connection-label"),
	connectionPulse: document.querySelector("#connection-pulse"),
	kernelLabel: document.querySelector("#kernel-label"),
	clock: document.querySelector("#clock"),
};

const numberFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 4,
});
const probabilityFormatter = new Intl.NumberFormat(undefined, {
	maximumSignificantDigits: 4,
	useGrouping: false,
});
const MAX_RENDERED_EXPERIMENTS = 60;
const MAX_RENDERED_GENERATIONS = 10;
const MAX_RENDERED_EVENTS = 80;

let snapshot;
let refreshTimer;
let connectionFailed = false;
let controlPending = false;
let notePending = false;
let refreshSequence = 0;
let appliedRefreshSequence = 0;
let appliedRevision = -1;
const workerRecords = new Map();
const workerState = new Map();

function showToast(message) {
	elements.toast.textContent = message;
	elements.toast.classList.add("visible");
	window.setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function messageFor(error) {
	return error instanceof Error ? error.message : String(error);
}

async function request(path, options = {}) {
	const headers = {
		"content-type": "application/json",
		...options.headers,
	};
	if (typeof token === "string" && token) {
		headers["x-iso-control-token"] = token;
	}
	const response = await fetch(path, {
		...options,
		headers,
	});
	const body = await response.json();
	if (!response.ok) {
		const error = new Error(body.error || `Request failed: ${response.status}`);
		error.status = response.status;
		error.body = body;
		throw error;
	}
	return body;
}

function timeLabel(value) {
	if (!value) return "—";
	const date = new Date(value);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortId(value, length = 9) {
	return value ? value.slice(0, length) : "—";
}

function formatNumber(value) {
	return Number.isFinite(value) ? numberFormatter.format(value) : "—";
}

function formatProbability(value) {
	if (!Number.isFinite(value)) return "—";
	const magnitude = Math.abs(value);
	return magnitude > 0 && magnitude < 0.001
		? value.toExponential(3).replace("e+", "e")
		: probabilityFormatter.format(value);
}

function formatSigned(value) {
	if (!Number.isFinite(value)) return "—";
	const sign = value > 0 ? "+" : "";
	return `${sign}${formatNumber(value)}`;
}

function formatDuration(milliseconds) {
	if (!Number.isFinite(milliseconds)) return "—";
	if (milliseconds >= 60 * 60 * 1000) {
		return `${formatNumber(milliseconds / (60 * 60 * 1000))}h`;
	}
	return `${formatNumber(milliseconds / (60 * 1000))}m`;
}

function statusBadge(status) {
	const span = document.createElement("span");
	span.className = "status-badge";
	span.dataset.status = status;
	span.textContent = status.replaceAll("-", " ").toUpperCase();
	return span;
}

function setProgress(element, value, maximum) {
	const safeMaximum = maximum > 0 ? maximum : 1;
	const safeValue = Math.min(safeMaximum, Math.max(0, value));
	element.max = safeMaximum;
	element.value = safeValue;
	element.setAttribute("aria-valuemin", "0");
	element.setAttribute("aria-valuemax", String(maximum > 0 ? maximum : 0));
	element.setAttribute("aria-valuenow", String(maximum > 0 ? safeValue : 0));
	if (maximum > 0) {
		element.removeAttribute("aria-valuetext");
	} else {
		element.setAttribute("aria-valuetext", "Not configured");
	}
}

function connectedLabel() {
	return relayMode ? "TRUSTED RELAY" : "LOCAL LINK";
}

function activeGenerationFor(campaign, generations) {
	return (
		generations.find((generation) => generation.id === campaign?.activeGenerationId) ??
		generations.slice().sort((left, right) => right.index - left.index)[0]
	);
}

function lowerConfidenceBound(improvement, uncertainty) {
	return Number.isFinite(improvement) && Number.isFinite(uncertainty)
		? improvement - uncertainty
		: undefined;
}

function authoritativeEvaluation(experiment) {
	return experiment?.confirmationEvaluation ?? experiment?.evaluation;
}

function latestConfirmationEvidence(experiment) {
	return (experiment?.confirmationHistory ?? [])
		.slice()
		.sort((left, right) => left.round - right.round)
		.at(-1);
}

function postSelectionEvidence(experiment) {
	return latestConfirmationEvidence(experiment)?.selection;
}

function planTrialCount(plan) {
	return Number.isSafeInteger(plan?.trialCount) ? plan.trialCount : plan?.trialIds?.length;
}

function opportunityFor(experiment, campaign) {
	const selection = postSelectionEvidence(experiment);
	return {
		index: selection?.opportunityIndex ?? experiment?.confirmationPlan?.opportunityIndex,
		maximum: selection?.maxOpportunities ?? campaign?.config.budget.maxGenerations,
	};
}

function claimLabel(selection) {
	if (!selection) return "POST-SELECTION CLAIM PENDING";
	if (selection.claimClass === "bounded-independent-trials-fwer") {
		return `BOUNDED INDEPENDENT-TRIAL FWER · FAMILY α=${formatProbability(
			selection.familyWiseAlpha,
		)} · ADJUSTED α=${formatProbability(selection.adjustedAlpha)}`;
	}
	return `ASSUMPTION-BASED PAIRED T · ADJUSTED α=${formatProbability(selection.adjustedAlpha)}`;
}

function methodLabel(method) {
	if (!method) return "POST-SELECTION METHOD PENDING";
	if (method === "paired-bounded-hoeffding-bonferroni-v1") {
		return "PAIRED BOUNDED HOEFFDING + BONFERRONI";
	}
	if (method === "paired-student-t-bonferroni-v1") {
		return "PAIRED STUDENT-T + BONFERRONI · ASSUMPTION-BASED";
	}
	return method.replace("-v1", "").replaceAll("-", " ").toUpperCase();
}

function planLabel(plan, campaign) {
	if (!plan) return "NO FROZEN PLAN";
	const trials = planTrialCount(plan);
	const opportunity = opportunityFor({ confirmationPlan: plan }, campaign);
	const parts = [`PLAN ${shortId(plan.id, 12)}`];
	if (Number.isSafeInteger(trials)) {
		parts.push(`n=${trials} PAIRED`);
	}
	if (Number.isSafeInteger(opportunity.index) && Number.isSafeInteger(opportunity.maximum)) {
		parts.push(`OPPORTUNITY ${opportunity.index}/${opportunity.maximum}`);
	}
	return parts.join(" · ");
}

function constraintState(evaluation) {
	if (!evaluation) {
		return { label: "NOT RUN", tone: "muted", title: "Evaluation has not run." };
	}
	const failed = evaluation.failedConstraints ?? [];
	if (!evaluation.valid || failed.length > 0) {
		const reason = failed.length > 0 ? failed.join(", ") : "invalid evaluator result";
		return { label: `FAIL · ${reason}`, tone: "negative", title: reason };
	}
	return { label: "PASS", tone: "positive", title: "All evaluator constraints passed." };
}

function addConstraintLine(container, label, evaluation) {
	const state = constraintState(evaluation);
	const line = document.createElement("small");
	line.className = `constraint-line ${state.tone}`;
	line.textContent = `${label} ${state.label}`;
	line.title = state.title;
	container.append(line);
}

function confirmationPending(experiment, campaign) {
	const pending = document.createElement("span");
	pending.className = "confirmation-pending";
	const marker = document.createElement("i");
	marker.setAttribute("aria-hidden", "true");
	const copy = document.createElement("span");
	copy.textContent = `FRESH REPLICATION RUNNING · ${planLabel(
		experiment?.confirmationPlan,
		campaign,
	)}`;
	pending.append(marker, copy);
	return pending;
}

function confirmationProgress(experiment) {
	const history = (experiment?.confirmationHistory ?? [])
		.slice()
		.sort((left, right) => left.round - right.round);
	const passedFromHistory = history.filter((entry) => entry.confirmed).reduce(
		(maximum, entry) => Math.max(maximum, entry.round),
		0,
	);
	const passed = Math.max(experiment?.confirmationRoundsPassed ?? 0, passedFromHistory) > 0 ? 1 : 0;
	return {
		history,
		latest: history.at(-1),
		passed,
	};
}

function verificationFor(campaign, generation, experiments, workers) {
	if (!campaign || generation?.status !== "verifying") return undefined;
	const generationExperiments = experiments.filter(
		(experiment) => experiment.generationId === generation.id,
	);
	const screeningActive =
		workers.some((worker) => worker.generationId === generation.id) ||
		generationExperiments.some((experiment) =>
			["workspace-ready", "agent-running", "candidate-frozen", "evaluating"].includes(
				experiment.status,
			),
		);
	if (screeningActive) {
		const measured = generationExperiments.filter((experiment) => experiment.evaluation).length;
		return {
			kind: "screening",
			title: "PAIRED SCREENING IN PROGRESS",
			detail: `${measured}/${generationExperiments.length} candidates measured against the pinned incumbent. Screening is exploratory and cannot promote a candidate.`,
			experimentId: undefined,
			completedBlocks: 0,
		};
	}

	const provisional = generationExperiments
		.filter(
			(experiment) =>
				experiment.status === "measured" &&
				(experiment.screeningPassed ||
					(experiment.confirmationHistory?.length ?? 0) > 0 ||
					(experiment.confirmationRoundsPassed ?? 0) > 0 ||
					Boolean(experiment.confirmationPlan) ||
					experiment.rejectionReason?.startsWith("Confirmation") ||
					experiment.rejectionReason?.startsWith("Fresh post-selection")),
		)
		.sort((left, right) => {
			const progressDifference =
				confirmationProgress(right).passed - confirmationProgress(left).passed;
			if (progressDifference !== 0) return progressDifference;
			const leftBound =
				lowerConfidenceBound(left.improvement, left.uncertainty) ??
				Number.NEGATIVE_INFINITY;
			const rightBound =
				lowerConfidenceBound(right.improvement, right.uncertainty) ??
				Number.NEGATIVE_INFINITY;
			return rightBound - leftBound || left.id.localeCompare(right.id);
		})[0];
	if (provisional) {
		const progress = confirmationProgress(provisional);
		const selection = progress.latest?.selection;
		const opportunity = opportunityFor(provisional, campaign);
		if (progress.latest && !progress.latest.confirmed) {
			return {
				kind: "closed",
				title: "FRESH POST-SELECTION REPLICATION REJECTED",
				detail:
					provisional.rejectionReason ||
					`Promotion lower bound ${formatSigned(progress.latest.lowerBound)} did not clear the threshold under ${selection?.claimClass ?? "the frozen selection contract"}.`,
				experimentId: provisional.id,
				completedBlocks: 1,
				opportunity,
				plan: provisional.confirmationPlan,
			};
		}
		if (
			(provisional.rejectionReason?.startsWith("Confirmation") ||
				provisional.rejectionReason?.startsWith("Fresh post-selection")) &&
			!provisional.credibleImprovement
		) {
			return {
				kind: "failed",
				title: "FRESH POST-SELECTION REPLICATION FAILED",
				detail: provisional.rejectionReason,
				experimentId: provisional.id,
				completedBlocks: progress.passed,
				opportunity,
				plan: provisional.confirmationPlan,
			};
		}
		if (progress.passed >= 1) {
			return {
				kind: "complete",
				title: "FRESH POST-SELECTION REPLICATION PASSED",
				detail: `${claimLabel(selection)} · promotion cleared the declared threshold.`,
				experimentId: provisional.id,
				completedBlocks: 1,
				opportunity,
				plan: provisional.confirmationPlan,
			};
		}
		return {
			kind: "confirmation",
			title: "FRESH POST-SELECTION REPLICATION",
			detail: "Screening selected one provisional candidate; its single frozen paired replication block is running.",
			experimentId: provisional.id,
			completedBlocks: progress.passed,
			opportunity,
			plan: provisional.confirmationPlan,
		};
	}
	return {
		kind: "selection",
		title: "SCREENING COMPLETE · FINALIZING EVIDENCE",
		detail: "No unconfirmed screening result is being presented as a promotion.",
		experimentId: undefined,
		completedBlocks: 0,
	};
}

function renderVerificationCard(verification) {
	const card = document.createElement("article");
	card.className = "verification-card";
	card.dataset.kind = verification.kind;
	const header = document.createElement("header");
	const label = document.createElement("span");
	label.className = "verification-label";
	const pulse = document.createElement("i");
	pulse.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent =
		verification.kind === "screening" ? "EXPLORATORY SCREEN" : "POST-SELECTION GATE";
	label.append(pulse, text);
	const state = document.createElement("span");
	state.className = "verification-state";
	state.textContent =
		verification.kind === "closed" || verification.kind === "failed"
			? "CLOSED"
			: verification.kind === "complete"
				? "PASSED"
				: "LIVE";
	header.append(label, state);
	const title = document.createElement("h3");
	title.textContent = verification.title;
	const detail = document.createElement("p");
	detail.textContent = verification.detail;
	card.append(header, title, detail);
	if (verification.experimentId) {
		const footer = document.createElement("footer");
		const candidate = document.createElement("code");
		candidate.textContent = `CANDIDATE ${shortId(verification.experimentId, 12)}`;
		const plan = document.createElement("span");
		plan.className = "verification-plan";
		plan.textContent = verification.plan
			? planLabel(verification.plan, {
					config: { budget: { maxGenerations: verification.opportunity?.maximum } },
				})
			: "PLAN FREEZING";
		footer.append(candidate, plan);
		card.append(footer);
	}
	return card;
}

function createWorkerRecord(workerId) {
	const card = document.createElement("article");
	card.className = "worker-card";
	card.dataset.workerId = workerId;
	const header = document.createElement("header");
	const identity = document.createElement("div");
	const eyebrow = document.createElement("small");
	const title = document.createElement("h3");
	identity.append(eyebrow, title);
	const badge = statusBadge("created");
	header.append(identity, badge);
	const activity = document.createElement("p");
	const timing = document.createElement("small");
	timing.className = "worker-time";
	const controls = document.createElement("div");
	controls.className = "worker-controls";
	const input = document.createElement("input");
	input.placeholder = "Give this worker new context…";
	const steer = document.createElement("button");
	steer.className = "button";
	steer.type = "button";
	steer.textContent = "STEER";
	const abort = document.createElement("button");
	abort.className = "button button-danger";
	abort.type = "button";
	abort.textContent = "ABORT";
	input.disabled = !canControl;
	steer.disabled = !canControl;
	abort.disabled = !canControl;
	const steerWorker = async () => {
		const worker = workerState.get(workerId);
		const message = input.value.trim();
		if (!worker || !message) return;
		steer.disabled = true;
		try {
			await sendControlRequest(`/api/workers/${encodeURIComponent(workerId)}/steer`, {
				message,
			});
			input.value = "";
			showToast("Context delivered to worker");
			scheduleRefresh();
		} catch (error) {
			showToast(messageFor(error));
			scheduleRefresh();
		} finally {
			steer.disabled = false;
		}
	};
	steer.addEventListener("click", steerWorker);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			void steerWorker();
		}
	});
	abort.addEventListener("click", async () => {
		const worker = workerState.get(workerId);
		if (
			!worker ||
			!window.confirm(`Abort ${worker.label}? Its last durable state will be preserved.`)
		) {
			return;
		}
		abort.disabled = true;
		try {
			await sendControlRequest(`/api/workers/${encodeURIComponent(workerId)}/abort`, {});
			showToast("Worker cancellation requested");
			scheduleRefresh();
		} catch (error) {
			abort.disabled = false;
			showToast(messageFor(error));
			scheduleRefresh();
		}
	});
	controls.append(input, steer, abort);
	card.append(header, activity, timing, controls);
	return { card, eyebrow, title, badge, activity, timing, input, steer, abort };
}

function renderWorkers(workers, verification, windowInfo) {
	const projectedWorkers = windowInfo?.shown.workers ?? workers.length;
	const totalWorkers = windowInfo?.totals.workers ?? workers.length;
	const workerWindow = `${workers.length} RENDERED · ${projectedWorkers} PROJECTED · ${totalWorkers} TOTAL`;
	elements.workerCount.textContent = verification ? `${workerWindow} · VERIFYING` : workerWindow;
	workerState.clear();
	for (const worker of workers) {
		workerState.set(worker.id, worker);
	}
	for (const [workerId, record] of workerRecords) {
		if (!workerState.has(workerId)) {
			record.card.remove();
			workerRecords.delete(workerId);
		}
	}

	const desiredNodes = [];
	if (verification) {
		desiredNodes.push(renderVerificationCard(verification));
	}
	if (workers.length === 0 && !verification) {
		const empty = document.createElement("div");
		empty.className = "empty-copy";
		const title = document.createElement("strong");
		title.textContent = "Workers are idle";
		const detail = document.createElement("span");
		detail.textContent = "Agents appear here while isolated experiments are running.";
		empty.append(title, detail);
		desiredNodes.push(empty);
	}
	for (const worker of workers) {
		let record = workerRecords.get(worker.id);
		if (!record) {
			record = createWorkerRecord(worker.id);
			workerRecords.set(worker.id, record);
		}
		record.eyebrow.textContent = `GEN ${shortId(worker.generationId, 6)} / ${shortId(
			worker.experimentId,
			8,
		)}`;
		record.title.textContent = worker.label;
		record.badge.dataset.status = worker.status;
		record.badge.textContent = worker.status.replaceAll("-", " ").toUpperCase();
		record.activity.textContent = worker.activity;
		record.timing.textContent = `STARTED ${timeLabel(worker.startedAt)}`;
		record.input.setAttribute("aria-label", `Steer ${worker.label}`);
		record.input.disabled = !canControl;
		record.steer.disabled = !canControl;
		record.abort.disabled = !canControl;
		desiredNodes.push(record.card);
	}
	for (let index = 0; index < desiredNodes.length; index += 1) {
		const desired = desiredNodes[index];
		const current = elements.workerList.children[index];
		if (current !== desired) {
			elements.workerList.insertBefore(desired, current ?? null);
		}
	}
	while (elements.workerList.children.length > desiredNodes.length) {
		elements.workerList.lastElementChild?.remove();
	}
}

function decisionFor(experiment, campaign) {
	if (experiment.status === "cancelled") {
		return ["CANCELLED", "warning", experiment.failure?.message];
	}
	if (experiment.status === "interrupted") {
		return ["INTERRUPTED", "warning", experiment.failure?.message];
	}
	if (experiment.status === "failed") {
		const labels = {
			agent: "AGENT FAILED",
			policy: "POLICY FAILED",
			infrastructure: "INFRA FAILED",
			"invalid-result": "INVALID RESULT",
			cancelled: "CANCELLED",
		};
		const phase = experiment.failure?.phase?.replaceAll("-", " ").toUpperCase();
		return [
			labels[experiment.failure?.kind] ?? (phase ? `${phase} FAILED` : "FAILED"),
			"negative",
			experiment.failure?.message,
		];
	}
	if (experiment.status === "invalid") {
		return ["INVALID", "negative", experiment.rejectionReason || experiment.failure?.message];
	}
	if (experiment.id === campaign?.championExperimentId) {
		return ["CONFIRMED CHAMPION", "positive", "Promoted by a fresh post-selection replication block."];
	}
	const selection = postSelectionEvidence(experiment);
	if (experiment.confirmationEvaluation) {
		if (experiment.credibleImprovement) {
			return ["CONFIRMED", "positive", claimLabel(selection)];
		}
		return [
			"REPLICATION REJECTED",
			"negative",
			experiment.rejectionReason || "Fresh post-selection replication did not clear the threshold.",
		];
	}
	if (
		experiment.rejectionReason?.startsWith("Confirmation") ||
		experiment.rejectionReason?.startsWith("Fresh post-selection")
	) {
		return ["REPLICATION FAILED", "negative", experiment.rejectionReason];
	}
	if (experiment.confirmationPlan) {
		return ["REPLICATING", "warning", planLabel(experiment.confirmationPlan, campaign)];
	}
	if (experiment.screeningPassed) {
		return ["SCREEN PASSED", "warning", "Requires one fresh post-selection replication block before promotion."];
	}
	if (experiment.status === "measured") {
		return ["SCREEN REJECTED", "muted", experiment.rejectionReason];
	}
	return ["PENDING", "muted"];
}

function renderExperiments(experiments, ideas, generations, campaign, verification) {
	const ideaById = new Map(ideas.map((idea) => [idea.id, idea]));
	const generationById = new Map(generations.map((generation) => [generation.id, generation]));
	elements.experimentTable.replaceChildren();
	elements.experimentEmpty.hidden = experiments.length > 0;
	const sorted = experiments
		.slice()
		.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
	const champion = sorted.find((experiment) => experiment.id === campaign?.championExperimentId);
	const ordered =
		champion && sorted.indexOf(champion) >= MAX_RENDERED_EXPERIMENTS
			? [champion, ...sorted.filter((experiment) => experiment !== champion)].slice(
					0,
					MAX_RENDERED_EXPERIMENTS,
				)
			: sorted.slice(0, MAX_RENDERED_EXPERIMENTS);
	for (const experiment of ordered) {
		const idea = ideaById.get(experiment.ideaId);
		const generation = generationById.get(experiment.generationId);
		const row = document.createElement("tr");
		if (experiment.id === campaign?.championExperimentId) {
			row.className = "champion-row";
		}
		const generationCell = document.createElement("td");
		generationCell.textContent = generation ? String(generation.index) : "—";
		const ideaCell = document.createElement("td");
		const ideaTitle = document.createElement("strong");
		ideaTitle.textContent = idea?.title || shortId(experiment.ideaId);
		const strategy = document.createElement("small");
		strategy.textContent = `${idea?.strategy || "unknown"} / ${shortId(experiment.candidateCommit)}`;
		ideaCell.title = idea?.hypothesis || experiment.assistantSummary || "";
		ideaCell.append(ideaTitle, strategy);
		const statusCell = document.createElement("td");
		statusCell.append(statusBadge(experiment.status));
		const scoreCell = document.createElement("td");
		if (experiment.evaluation) {
			const score = document.createElement("strong");
			score.textContent = formatNumber(experiment.evaluation.score.mean);
			const control = document.createElement("small");
			control.textContent = `CONTROL ${formatNumber(
				experiment.incumbentEvaluation?.score.mean,
			)} · n=${experiment.evaluation.sampleCount ?? experiment.evaluation.samples.length}`;
			scoreCell.append(score, control);
			addConstraintLine(scoreCell, "CAND", experiment.evaluation);
			addConstraintLine(scoreCell, "CTRL", experiment.incumbentEvaluation);
		} else {
			scoreCell.textContent = "—";
		}
		const improvementCell = document.createElement("td");
		const improvement = document.createElement("strong");
		improvement.textContent = Number.isFinite(experiment.uncertainty)
			? `${formatSigned(experiment.improvement)} ±${formatNumber(experiment.uncertainty)}`
			: formatSigned(experiment.improvement);
		const lowerBound = document.createElement("small");
		const screeningBound = lowerConfidenceBound(
			experiment.improvement,
			experiment.uncertainty,
		);
		lowerBound.textContent = `EXPLORATORY LCB ${formatSigned(screeningBound)}`;
		lowerBound.className = Number.isFinite(screeningBound)
			? screeningBound >= (campaign?.metric.minimumImprovement ?? Number.POSITIVE_INFINITY)
				? "positive"
				: "negative"
			: "muted";
		const threshold = document.createElement("small");
		threshold.className = "threshold-line";
		threshold.textContent = `NEED ≥ ${formatNumber(campaign?.metric.minimumImprovement)}`;
		improvementCell.append(improvement, lowerBound, threshold);

		const confirmationCell = document.createElement("td");
		if (experiment.confirmationEvaluation) {
			const evidence = latestConfirmationEvidence(experiment);
			const selection = evidence?.selection;
			const confirmationScore = document.createElement("strong");
			confirmationScore.textContent = formatNumber(
				experiment.confirmationEvaluation.score.mean,
			);
			const confirmationControl = document.createElement("small");
			confirmationControl.textContent = `CONTROL ${formatNumber(
				experiment.confirmationIncumbentEvaluation?.score.mean,
			)} · FRESH n=${selection?.sampleCount ?? experiment.confirmationEvaluation.sampleCount ?? "—"}`;
			const confirmationDelta = document.createElement("small");
			const confirmationBound =
				evidence?.lowerBound ??
				lowerConfidenceBound(
					experiment.confirmationImprovement,
					experiment.confirmationUncertainty,
				);
			confirmationDelta.textContent = `FINAL STEP VS INCUMBENT · Δ ${formatSigned(
				experiment.confirmationImprovement,
			)} ±${formatNumber(experiment.confirmationUncertainty)} · LOWER BOUND ${formatSigned(
				confirmationBound,
			)}`;
			confirmationDelta.className = Number.isFinite(confirmationBound)
				? experiment.credibleImprovement &&
					confirmationBound >=
						(campaign?.metric.minimumImprovement ?? Number.POSITIVE_INFINITY)
					? "positive"
					: "negative"
				: "muted";
			confirmationCell.append(
				confirmationScore,
				confirmationControl,
				confirmationDelta,
			);
			const claim = document.createElement("small");
			claim.className = experiment.credibleImprovement ? "positive" : "negative";
			claim.textContent = claimLabel(selection);
			const plan = document.createElement("small");
			plan.className = "evidence-plan";
			plan.textContent = planLabel(experiment.confirmationPlan, campaign);
			confirmationCell.append(claim, plan);
			addConstraintLine(confirmationCell, "CAND", experiment.confirmationEvaluation);
			addConstraintLine(
				confirmationCell,
				"CTRL",
				experiment.confirmationIncumbentEvaluation,
			);
			if (
				verification?.kind === "confirmation" &&
				verification.experimentId === experiment.id
			) {
				confirmationCell.append(confirmationPending(experiment, campaign));
			}
		} else if (
			verification?.kind === "confirmation" &&
			verification.experimentId === experiment.id
		) {
			const detail = document.createElement("small");
			detail.textContent = "Fresh paired candidate + control";
			confirmationCell.append(
				confirmationPending(experiment, campaign),
				detail,
			);
		} else if (experiment.screeningPassed) {
			const screenOnly = document.createElement("strong");
			screenOnly.className = "screen-only";
			screenOnly.textContent = "SCREEN PASSED";
			const detail = document.createElement("small");
			detail.textContent = "Fresh post-selection replication not recorded";
			confirmationCell.append(screenOnly, detail);
		} else {
			confirmationCell.textContent = "—";
		}
		const decisionCell = document.createElement("td");
		const [decision, tone, detail] = decisionFor(experiment, campaign);
		const decisionBadge = document.createElement("span");
		decisionBadge.className = `decision ${tone}`;
		decisionBadge.textContent = decision;
		if (detail || experiment.rejectionReason || experiment.failure?.message) {
			decisionBadge.title =
				detail || experiment.rejectionReason || experiment.failure.message;
		}
		decisionCell.append(decisionBadge);
		row.append(
			generationCell,
			ideaCell,
			statusCell,
			scoreCell,
			improvementCell,
			confirmationCell,
			decisionCell,
		);
		elements.experimentTable.append(row);
	}
}

function renderGenerations(generations, experiments, campaign, verification) {
	const experimentById = new Map(experiments.map((experiment) => [experiment.id, experiment]));
	elements.generationList.replaceChildren();
	if (generations.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty-copy";
		const title = document.createElement("strong");
		title.textContent = "No generations yet";
		const detail = document.createElement("span");
		detail.textContent = "Every pass is pinned to a known git commit.";
		empty.append(title, detail);
		elements.generationList.append(empty);
		return;
	}
	for (const generation of generations
		.slice()
		.sort((left, right) => right.index - left.index)
		.slice(0, MAX_RENDERED_GENERATIONS)) {
		const card = document.createElement("article");
		card.className = "generation-card";
		if (generation.id === campaign?.activeGenerationId) {
			card.classList.add("active");
		}
		const header = document.createElement("header");
		const index = document.createElement("strong");
		index.textContent = `GENERATION ${generation.index}`;
		header.append(index, statusBadge(generation.status));
		const base = document.createElement("code");
		base.textContent = `BASE ${shortId(generation.baseCommit)}`;
		const result = document.createElement("p");
		const selected = generation.selectedExperimentId
			? experimentById.get(generation.selectedExperimentId)
			: undefined;
		const selectedEvaluation = authoritativeEvaluation(selected);
		if (selectedEvaluation) {
			result.textContent = `${selected?.confirmationEvaluation ? "Promoted" : "Screened"} mean ${formatNumber(
				selectedEvaluation.score.mean,
			)} from ${generation.experimentCount ?? generation.experimentIds.length} candidates`;
		} else if (verification && generation.id === campaign?.activeGenerationId) {
			result.textContent = verification.title;
		} else {
			result.textContent = `${generation.experimentCount ?? generation.experimentIds.length} candidates / ${
				generation.ideaCount ?? generation.ideaIds.length
			} hypotheses`;
		}
		card.append(header, result);
		if (selected?.confirmationEvaluation) {
			const evidence = document.createElement("small");
			evidence.className = "generation-evidence";
			evidence.textContent = `FINAL STEP VS INCUMBENT · FRESH REPLICATION Δ ${formatSigned(
				selected.confirmationImprovement,
			)} · PROMOTION LOWER BOUND ${formatSigned(
				latestConfirmationEvidence(selected)?.lowerBound ??
					lowerConfidenceBound(
						selected.confirmationImprovement,
						selected.confirmationUncertainty,
					),
			)} · ${claimLabel(postSelectionEvidence(selected))}`;
			card.append(evidence);
		}
		card.append(base);
		elements.generationList.append(card);
	}
}

function renderList(element, values, emptyText) {
	element.replaceChildren();
	if (values.length === 0) {
		const item = document.createElement("li");
		item.className = "muted";
		item.textContent = emptyText;
		element.append(item);
		return;
	}
	for (const value of values) {
		const item = document.createElement("li");
		item.textContent = value;
		element.append(item);
	}
}

function renderReflection(reflections, generations) {
	const reflection = reflections.at(-1);
	if (!reflection) {
		elements.reflectionGeneration.textContent = "NO REFLECTION";
		elements.reflectionSummary.textContent =
			"ISO preserves useful failures and measured dead ends for the next planner pass.";
		renderList(elements.lessonList, [], "Awaiting measured evidence");
		renderList(elements.deadEndList, [], "No dead ends recorded");
		renderList(elements.nextFocusList, [], "Planner has not reflected yet");
		return;
	}
	const generation = generations.find((candidate) => candidate.id === reflection.generationId);
	elements.reflectionGeneration.textContent = generation
		? `GENERATION ${generation.index}`
		: shortId(reflection.generationId);
	elements.reflectionSummary.textContent = reflection.summary;
	renderList(elements.lessonList, reflection.lessons, "No explicit lessons");
	renderList(elements.deadEndList, reflection.deadEnds, "No dead ends recorded");
	renderList(elements.nextFocusList, reflection.nextFocus, "No next focus recorded");
}

function renderEvents(events) {
	elements.eventList.replaceChildren();
	if (events.length === 0) {
		const empty = document.createElement("li");
		empty.className = "ledger-empty";
		empty.textContent = "The durable event ledger is empty.";
		elements.eventList.append(empty);
		return;
	}
	for (const event of events.slice(-MAX_RENDERED_EVENTS).reverse()) {
		const item = document.createElement("li");
		const marker = document.createElement("i");
		marker.dataset.actor = event.actor;
		const time = document.createElement("time");
		time.dateTime = event.at;
		time.textContent = timeLabel(event.at);
		const content = document.createElement("div");
		const summary = document.createElement("p");
		summary.textContent = event.summary;
		const meta = document.createElement("small");
		meta.textContent = `${event.actor.toUpperCase()} / ${event.type}`;
		content.append(summary, meta);
		item.append(marker, time, content);
		elements.eventList.append(item);
	}
}

function graphColors(node) {
	const colors = {
		campaign: ["#f0f2e9", "#080b08"],
		generation: ["#b79cff", "#080b08"],
		idea: ["#71a4ff", "#080b08"],
		experiment: ["#ffbc57", "#080b08"],
		result: ["#b9f255", "#080b08"],
		reflection: ["#f690cb", "#080b08"],
	};
	return colors[node.kind] || ["#929b8d", "#080b08"];
}

function truncate(value, limit) {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function drawGraph(graph) {
	const canvas = elements.graph;
	const rect = canvas.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) return 0;
	const ratio = window.devicePixelRatio || 1;
	canvas.width = Math.round(rect.width * ratio);
	canvas.height = Math.round(rect.height * ratio);
	const context = canvas.getContext("2d");
	context.scale(ratio, ratio);
	context.clearRect(0, 0, rect.width, rect.height);

	const kinds = ["campaign", "generation", "idea", "experiment", "result", "reflection"];
	const columns = {
		campaign: rect.width * 0.06,
		generation: rect.width * 0.22,
		idea: rect.width * 0.39,
		experiment: rect.width * 0.58,
		result: rect.width * 0.78,
		reflection: rect.width * 0.94,
	};
	const visibleNodes = kinds.flatMap((kind) => {
		const nodes = graph.nodes.filter((node) => node.kind === kind);
		return kind === "campaign" ? nodes.slice(-1) : nodes.slice(-12);
	});
	elements.graphEmpty.hidden = visibleNodes.length > 1;
	if (visibleNodes.length === 0) return 0;

	const positions = new Map();
	for (const kind of kinds) {
		const nodes = visibleNodes.filter((node) => node.kind === kind);
		nodes.forEach((node, index) => {
			positions.set(node.id, {
				x: columns[kind],
				y: ((index + 1) * (rect.height - 36)) / (nodes.length + 1) + 18,
			});
		});
	}

	context.lineWidth = 1;
	for (const edge of graph.edges) {
		const from = positions.get(edge.from);
		const to = positions.get(edge.to);
		if (!from || !to) continue;
		context.beginPath();
		context.moveTo(from.x, from.y);
		const control = (from.x + to.x) / 2;
		context.bezierCurveTo(control, from.y, control, to.y, to.x, to.y);
		context.strokeStyle = edge.kind === "champions" ? "#b9f255" : "#343a32";
		context.setLineDash(edge.kind === "derived-from" || edge.kind === "reflects-on" ? [4, 5] : []);
		context.stroke();
	}
	context.setLineDash([]);

	for (const node of visibleNodes) {
		const position = positions.get(node.id);
		if (!position) continue;
		const [fill, text] = graphColors(node);
		const radius = node.kind === "campaign" ? 12 : node.kind === "generation" ? 10 : 8;
		context.beginPath();
		context.arc(position.x, position.y, radius, 0, Math.PI * 2);
		context.fillStyle = fill;
		context.fill();
		context.fillStyle = text;
		context.font = "700 7px SFMono-Regular, monospace";
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(node.kind.slice(0, 1).toUpperCase(), position.x, position.y + 0.5);
		context.fillStyle = "#d9ddd3";
		context.font = "500 9px SFMono-Regular, monospace";
		context.textAlign = "center";
		context.textBaseline = "top";
		context.fillText(truncate(node.label, 18), position.x, position.y + radius + 7);
	}
	return visibleNodes.length;
}

function renderLineage(
	graph,
	campaign,
	currentGeneration,
	experiments,
	ideas,
	generations,
	windowInfo,
	renderedGraphNodes,
) {
	const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
	const experimentById = new Map(
		experiments.map((experiment) => [experiment.id, experiment]),
	);
	const ideaById = new Map(ideas.map((idea) => [idea.id, idea]));
	const generationById = new Map(
		generations.map((generation) => [generation.id, generation]),
	);
	const lineageIds = [];
	const champion = experimentById.get(campaign?.championExperimentId);
	if (champion) {
		const championIdea = ideaById.get(champion.ideaId);
		lineageIds.push(champion.generationId, championIdea?.id, champion.id);
		if (champion.evaluation) {
			lineageIds.push(`result_screen_${champion.id}`);
		}
		if ((champion.confirmationHistory?.length ?? 0) > 0) {
			lineageIds.push(`result_confirmation_${champion.id}`);
		}
		for (const parentId of championIdea?.parentIdeaIds ?? []) {
			lineageIds.unshift(parentId);
		}
	}
	if (currentGeneration) {
		lineageIds.push(currentGeneration.id);
		const currentExperiments = experiments
			.filter((experiment) => experiment.generationId === currentGeneration.id)
			.slice(-3);
		for (const experiment of currentExperiments) {
			lineageIds.push(experiment.ideaId, experiment.id);
			if (experiment.evaluation) {
				lineageIds.push(`result_screen_${experiment.id}`);
			}
			if ((experiment.confirmationHistory?.length ?? 0) > 0) {
				lineageIds.push(`result_confirmation_${experiment.id}`);
			}
		}
	}
	const uniqueIds = [...new Set(lineageIds.filter(Boolean))];
	elements.lineageList.replaceChildren();
	for (const id of uniqueIds) {
		const node = nodeById.get(id);
		if (!node) continue;
		const item = document.createElement("li");
		if (
			id === campaign?.championExperimentId ||
			experimentById.get(campaign?.championExperimentId)?.ideaId === id
		) {
			item.dataset.lineage = "champion";
		} else if (
			id === currentGeneration?.id ||
			experimentById.get(id)?.generationId === currentGeneration?.id
		) {
			item.dataset.lineage = "current";
		}
		const kind = document.createElement("span");
		kind.textContent = node.kind.toUpperCase();
		const description = document.createElement("strong");
		description.textContent = node.label;
		const provenance = document.createElement("code");
		const experiment = experimentById.get(id);
		const generation = generationById.get(id);
		provenance.textContent = experiment?.candidateCommit
			? `${shortId(experiment.candidateCommit, 12)} · ${node.status}`
			: generation?.baseCommit
				? `${shortId(generation.baseCommit, 12)} · ${node.status}`
				: `${shortId(id, 12)} · ${node.status}`;
		item.append(kind, description, provenance);
		elements.lineageList.append(item);
	}
	const shownNodes = windowInfo?.shown.graphNodes ?? graph.nodes.length;
	const totalNodes = windowInfo?.totals.graphNodes ?? graph.nodes.length;
	const championText = champion
		? `champion ${shortId(champion.candidateCommit, 12)}`
		: "baseline champion";
	elements.graphSummary.textContent = `${renderedGraphNodes} rendered · ${shownNodes} projected · ${totalNodes} total evidence nodes · ${championText} · current generation ${
		currentGeneration?.index ?? "—"
	}`;
	elements.graph.setAttribute(
		"aria-label",
		`Research lineage graph rendering ${renderedGraphNodes} of ${shownNodes} projected nodes and ${totalNodes} total nodes; ${championText}.`,
	);
}

function renderGuidance(notes) {
	const queued = notes.filter((note) => note.status === "queued").length;
	const consumed = notes.filter((note) => note.status === "consumed").length;
	elements.guidanceSummary.textContent = `${queued} queued · ${consumed} consumed`;
	elements.guidanceList.replaceChildren();
	if (notes.length === 0) {
		const empty = document.createElement("li");
		empty.className = "empty-copy";
		const title = document.createElement("strong");
		title.textContent = "No guidance queued";
		const detail = document.createElement("span");
		detail.textContent = "Conversation notes appear here when accepted by the durable mission.";
		empty.append(title, detail);
		elements.guidanceList.append(empty);
		return;
	}
	for (const note of notes.slice().reverse()) {
		const item = document.createElement("li");
		item.dataset.status = note.status;
		const header = document.createElement("div");
		const state = document.createElement("strong");
		state.textContent = note.status.toUpperCase();
		const timing = document.createElement("time");
		timing.dateTime = note.consumedAt || note.createdAt;
		timing.textContent = note.consumedAt
			? `CONSUMED ${timeLabel(note.consumedAt)}`
			: `QUEUED ${timeLabel(note.createdAt)}`;
		header.append(state, timing);
		const message = document.createElement("p");
		message.textContent = note.message;
		item.append(header, message);
		if (note.hypothesis?.title) {
			const hypothesis = document.createElement("small");
			hypothesis.textContent = `HYPOTHESIS · ${note.hypothesis.title}`;
			item.append(hypothesis);
		}
		if (note.consumedGenerationId) {
			const generation = document.createElement("code");
			generation.textContent = `GENERATION ${shortId(note.consumedGenerationId, 12)}`;
			item.append(generation);
		}
		elements.guidanceList.append(item);
	}
}

function reportDatum(label, value) {
	const item = document.createElement("div");
	const key = document.createElement("span");
	key.textContent = label;
	const content = document.createElement("strong");
	content.textContent = value;
	item.append(key, content);
	return item;
}

function renderCompletion(mission, campaign, experiments) {
	const report = mission?.completionReport ?? campaign?.completionReport;
	elements.completionReport.replaceChildren();
	if (!report) {
		elements.completionState.textContent = mission?.phase
			? mission.phase.replaceAll("-", " ").toUpperCase()
			: "IN PROGRESS";
		const empty = document.createElement("div");
		empty.className = "empty-copy";
		const title = document.createElement("strong");
		title.textContent = mission?.phase === "failed" ? "No completion report was retained" : "Research is still live";
		const detail = document.createElement("span");
		detail.textContent =
			mission?.diagnostics?.at(-1)?.message ||
			"The final report and exact champion commit will land here.";
		empty.append(title, detail);
		elements.completionReport.append(empty);
		return;
	}
	elements.completionState.textContent = report.outcome.toUpperCase();
	const reason = document.createElement("p");
	reason.className = "completion-reason";
	reason.textContent = report.reason;
	const stats = document.createElement("div");
	stats.className = "completion-stats";
	stats.append(
		reportDatum("GENERATIONS", String(report.generationsCompleted)),
		reportDatum("MEASURED", String(report.measuredExperiments)),
		reportDatum("FAILURES", String(report.failures)),
		reportDatum("AGENT CALLS", String(report.agentUsage.agentCalls)),
	);
	elements.completionReport.append(reason, stats);
	const champion = report.champion;
	if (champion) {
		const handoff = document.createElement("section");
		handoff.className = "champion-handoff";
		const heading = document.createElement("h3");
		heading.textContent = "EXACT CHAMPION HANDOFF";
		const commit = document.createElement("code");
		commit.textContent = champion.candidateCommit;
		const score = document.createElement("p");
		score.textContent = `${formatNumber(champion.baselineScore)} → ${formatNumber(
			champion.championScore,
		)}`;
		const cumulative = document.createElement("p");
		cumulative.className = "handoff-measure";
		cumulative.textContent = `CUMULATIVE VS BASELINE · Δ ${formatSigned(
			champion.cumulativeImprovement ?? champion.improvement,
		)} ±${formatNumber(champion.cumulativeUncertainty ?? champion.uncertainty)}`;
		const step = document.createElement("p");
		step.className = "handoff-measure";
		step.textContent = `FINAL STEP VS INCUMBENT · Δ ${formatSigned(
			champion.stepImprovement ?? champion.improvement,
		)} ±${formatNumber(champion.stepUncertainty ?? champion.uncertainty)}`;
		const championExperiment = experiments.find(
			(experiment) => experiment.id === champion.experimentId,
		);
		const selection = postSelectionEvidence(championExperiment);
		const replication = document.createElement("small");
		replication.textContent = `${champion.confirmationRoundsPassed} fresh post-selection replication block${
			champion.confirmationRoundsPassed === 1 ? "" : "s"
		} · ${claimLabel(selection)}`;
		const precondition = document.createElement("small");
		precondition.textContent = `Apply only at HEAD ${shortId(
			champion.applyPrecondition.expectedHead,
			16,
		)} with a clean worktree${
			champion.applyPrecondition.requiresDirtySourceReconciliation
				? "; reconcile the captured dirty source first"
				: ""
		}.`;
		handoff.append(heading, commit, score, cumulative, step, replication, precondition);
		elements.completionReport.append(handoff);
	}
	if (report.keyFindings.length > 0) {
		const findings = document.createElement("ul");
		for (const finding of report.keyFindings.slice(0, 8)) {
			const item = document.createElement("li");
			item.textContent = finding;
			findings.append(item);
		}
		elements.completionReport.append(findings);
	}
}

function researchIsPaused(mission, campaign) {
	return (
		mission?.desiredState === "paused" ||
		mission?.phase === "paused" ||
		campaign?.status === "paused" ||
		campaign?.status === "pausing"
	);
}

function renderControls(mission, campaign) {
	const status = campaign?.status;
	const missionTerminal = Boolean(
		mission && ["completed", "stopped", "failed"].includes(mission.phase),
	);
	const paused = researchIsPaused(mission, campaign);
	const targetAvailable = canControl && Boolean(snapshot?.control) && !missionTerminal;
	const canStart = targetAvailable && (paused || status === "ready");
	const canPause = targetAvailable && !paused;
	const canStop = targetAvailable;
	const canNote = targetAvailable;
	const pending = controlPending || notePending || connectionFailed || !snapshot;
	elements.startButton.disabled = pending || !canStart;
	elements.pauseButton.disabled = pending || !canPause;
	elements.stopButton.disabled = pending || !canStop;
	elements.campaignMessageInput.disabled = pending || !canNote;
	elements.campaignMessageSend.disabled = pending || !canNote;
	elements.startButton.textContent = paused ? "RESUME" : "START";
}

function render(nextSnapshot) {
	snapshot = nextSnapshot;
	const mission = snapshot.activeMission ?? snapshot.state.missions.at(-1);
	const campaign = snapshot.activeCampaign;
	const config = campaign?.config ?? mission?.input.config;
	const metric = campaign?.metric ?? mission?.input.metric;
	const campaignId = campaign?.id;
	const ideas = campaignId
		? snapshot.state.ideas.filter((idea) => idea.campaignId === campaignId)
		: [];
	const generations = campaignId
		? snapshot.state.generations.filter((generation) => generation.campaignId === campaignId)
		: [];
	const experiments = campaignId
		? snapshot.state.experiments.filter((experiment) => experiment.campaignId === campaignId)
		: [];
	const reflections = campaignId
		? snapshot.state.reflections.filter((reflection) => reflection.campaignId === campaignId)
		: [];
	const campaignEvents = snapshot.state.events.filter(
		(event) => !campaignId || event.campaignId === campaignId,
	);
	const ledgerEvents = campaignId
		? campaignEvents
		: snapshot.state.materialUpdates.map((update) => ({
				id: `mission-update-${update.sequence}`,
				sequence: update.sequence,
				type: `mission.${update.kind}`,
				summary: update.summary,
				actor: update.kind === "operator" ? "human" : "system",
				at: update.at,
				refs: update.refs,
			}));
	const currentGeneration = activeGenerationFor(campaign, generations);
	const verification = verificationFor(
		campaign,
		currentGeneration,
		experiments,
		snapshot.workers,
	);
	const champion = experiments.find((experiment) => experiment.id === campaign?.championExperimentId);
	const baselineMean = campaign?.baseline.evaluation.score.mean;
	const championEvaluation = authoritativeEvaluation(champion);
	const championMean = championEvaluation?.score.mean;
	const currentMean = championMean ?? baselineMean;
	const baselineDelta =
		Number.isFinite(championMean) && Number.isFinite(baselineMean)
			? campaign.metric.direction === "maximize"
				? championMean - baselineMean
				: baselineMean - championMean
			: undefined;
	const completedGenerations = generations.filter((generation) => generation.status === "completed").length;
	const confirmedExperiments = experiments.filter(
		(experiment) =>
			experiment.confirmationEvaluation &&
			experiment.credibleImprovement &&
			postSelectionEvidence(experiment)?.promoted === true,
	).length;
	const championSelection = postSelectionEvidence(champion);
	const latestPlannedExperiment =
		(champion?.confirmationPlan || champion?.screeningPlan ? champion : undefined) ??
		experiments
			.filter((experiment) => experiment.confirmationPlan || experiment.screeningPlan)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

	const missionPhase = mission?.phase ?? campaign?.status;
	elements.campaignGoal.textContent =
		mission?.input.goal || campaign?.goal || "Tell ISO what should get better.";
	elements.campaignStatus.textContent = missionPhase
		? missionPhase.replaceAll("-", " ").toUpperCase()
		: "NO MISSION";
	elements.campaignStatus.dataset.status = missionPhase || "offline";
	elements.missionDetail.textContent =
		campaign?.stopReason ||
		mission?.completionReport?.reason ||
		mission?.diagnostics?.at(-1)?.message ||
		(config && metric
			? `${config.workers} parallel workers · ${config.evaluator.samples} evaluator samples · ${
					config.evaluator.scoreBounds
						? `declared score bounds [${formatNumber(config.evaluator.scoreBounds.min)}, ${formatNumber(
								config.evaluator.scoreBounds.max,
							)}]`
						: "unbounded score; promotion claim is assumption-based"
				} · ${metric.minimumImprovement} minimum lift`
			: "The agent will inspect the repository, define a protected evaluator, calibrate a baseline, and run the research loop.");
	elements.generationLabel.textContent = currentGeneration
		? `#${currentGeneration.index}`
		: missionPhase
			? missionPhase.replaceAll("-", " ").toUpperCase()
			: "—";
	elements.controlHint.textContent = campaign
		? verification
			? `${verification.title} · ADMISSION EPOCH ${snapshot.state.admissionEpoch} · pinned ${shortId(
					currentGeneration?.baseCommit || campaign.sourceCommit,
				)}`
			: `CONTROL ${snapshot.control?.kind?.toUpperCase() ?? "CLOSED"} · ADMISSION EPOCH ${
					snapshot.state.admissionEpoch
				} · pinned ${shortId(currentGeneration?.baseCommit || campaign.sourceCommit)}`
		: mission
			? `ADMISSION EPOCH ${snapshot.state.admissionEpoch} · frozen source ${shortId(
					mission.input.sourceCommit,
				)} · the kernel owns calibration and recovery`
			: `ADMISSION EPOCH ${snapshot.state.admissionEpoch} · no admitted control target`;

	elements.baselineScore.textContent = formatNumber(baselineMean);
	elements.championScore.textContent = formatNumber(currentMean);
	elements.metricLabel.textContent = metric
		? `MEAN · ${metric.direction.toUpperCase()} ${metric.name.toUpperCase()}`
		: "NO METRIC";
	elements.championLabel.textContent = champion
		? `${shortId(champion.candidateCommit)} / POST-SELECTED`
		: campaign
			? "BASELINE HOLDS"
			: "AWAITING EVIDENCE";
	elements.deltaScore.textContent = formatSigned(baselineDelta);
	elements.deltaScore.classList.toggle("positive", Number.isFinite(baselineDelta) && baselineDelta > 0);
	elements.deltaLabel.textContent = champion
		? "CUMULATIVE VS ORIGINAL BASELINE · POINT ESTIMATE"
		: "NO PROMOTED CUMULATIVE DELTA";
	const championConfirmationBound =
		latestConfirmationEvidence(champion)?.lowerBound ??
		lowerConfidenceBound(
			champion?.confirmationImprovement,
			champion?.confirmationUncertainty,
		);
	elements.confidenceLabel.textContent = champion?.confirmationEvaluation
		? `FINAL STEP VS INCUMBENT · FRESH Δ ${formatSigned(
				champion.confirmationImprovement,
			)} ±${formatNumber(champion.confirmationUncertainty)} · LOWER BOUND ${formatSigned(
				championConfirmationBound,
			)} · ${claimLabel(championSelection)}`
		: champion
			? "SCREENING ONLY · FRESH REPLICATION NOT RECORDED"
			: "NO POST-SELECTION REPLICATION";
	elements.confidenceLabel.title = elements.confidenceLabel.textContent;
	const projectedGenerations = snapshot.window?.shown.generations ?? generations.length;
	const totalGenerations = snapshot.window?.totals.generations ?? generations.length;
	const renderedGenerations = Math.min(generations.length, MAX_RENDERED_GENERATIONS);
	const projectedExperiments = snapshot.window?.shown.experiments ?? experiments.length;
	const totalExperiments = snapshot.window?.totals.experiments ?? experiments.length;
	const renderedExperiments = Math.min(experiments.length, MAX_RENDERED_EXPERIMENTS);
	elements.generationCount.textContent = String(totalGenerations);
	elements.generationDetail.textContent = `${campaign?.generationsCompleted ?? completedGenerations} complete / ${
		renderedGenerations
	} rendered / ${projectedGenerations} projected`;
	elements.experimentCount.textContent = String(totalExperiments);
	elements.experimentDetail.textContent = `${confirmedExperiments} confirmed in projection / ${renderedExperiments} rendered`;
	elements.evidenceWindowNote.textContent = `${renderedExperiments} rendered · ${projectedExperiments} projected · ${totalExperiments} total candidates · champion pinned · exploratory screen + fresh promotion gate`;
	elements.generationWindowNote.textContent = `${renderedGenerations} rendered · ${projectedGenerations} projected · ${totalGenerations} total`;
	const retainedEvents = campaignId
		? (snapshot.window?.shown.events ?? ledgerEvents.length)
		: (snapshot.window?.shown.materialUpdates ?? ledgerEvents.length);
	const totalEvents = campaignId
		? (snapshot.window?.totals.events ?? ledgerEvents.length)
		: (snapshot.window?.totals.materialUpdates ?? ledgerEvents.length);
	elements.ledgerWindowNote.textContent = `${Math.min(
		MAX_RENDERED_EVENTS,
		ledgerEvents.length,
	)} rendered · ${retainedEvents} projected · ${totalEvents} total`;

	const budget = config?.budget;
	const elapsed = campaign?.startedAt ? Math.max(0, Date.now() - new Date(campaign.startedAt).getTime()) : 0;
	elements.budgetSummary.textContent = budget
		? `${formatDuration(elapsed)} / ${formatDuration(budget.maxWallClockMs)} · ${campaign?.failures ?? 0}/${budget.maxFailures} failures · ${config.workers} workers`
		: "No mission budget";
	elements.generationBudgetLabel.textContent = budget
		? `${campaign?.generationsCompleted ?? 0} / ${budget.maxGenerations}`
		: "0 / 0";
	elements.experimentBudgetLabel.textContent = budget
		? `${campaign?.experimentsStarted ?? 0} / ${budget.maxExperiments}`
		: "0 / 0";
	elements.plateauBudgetLabel.textContent = budget
		? `${campaign?.consecutivePlateaus ?? 0} / ${budget.maxConsecutivePlateaus}`
		: "0 / 0";
	setProgress(elements.generationProgress, campaign?.generationsCompleted ?? 0, budget?.maxGenerations ?? 0);
	setProgress(elements.experimentProgress, campaign?.experimentsStarted ?? 0, budget?.maxExperiments ?? 0);
	setProgress(elements.plateauProgress, campaign?.consecutivePlateaus ?? 0, budget?.maxConsecutivePlateaus ?? 0);

	elements.evaluatorDigest.textContent = campaign ? shortId(campaign.evaluatorDigest, 16) : "not calibrated";
	elements.evaluatorDigest.title = campaign?.evaluatorDigest || "";
	const sourceCommit = campaign?.sourceCommit ?? mission?.input.sourceCommit;
	elements.sourceCommit.textContent = sourceCommit ? shortId(sourceCommit, 16) : "—";
	elements.sourceCommit.title = sourceCommit || "";
	const provenance = campaign?.runtimeProvenance;
	elements.runtimeProvenance.textContent = provenance
		? `ISO ${provenance.isoVersion} · NODE ${provenance.nodeVersion} · SANDBOX ${provenance.sandboxRuntimeVersion}`
		: "—";
	elements.runtimeProvenance.title = provenance?.artifactDigest || "";
	const latestSelection =
		championSelection ??
		experiments
			.map(postSelectionEvidence)
			.filter(Boolean)
			.at(-1);
	elements.selectionContract.textContent = latestSelection
		? `${methodLabel(latestSelection.method)} · ${claimLabel(latestSelection)}`
		: methodLabel(provenance?.selectionMethod);
	elements.selectionContract.title = latestSelection?.assumptions?.join("\n") || provenance?.evaluatorContract || "";
	const latestPlan =
		latestPlannedExperiment?.confirmationPlan ??
		latestPlannedExperiment?.screeningPlan;
	elements.evaluationPlan.textContent = planLabel(latestPlan, campaign);
	elements.evaluationPlan.title = latestPlan?.id || "";
	const controlTarget = snapshot.control;
	elements.controlBarrier.textContent = controlTarget
		? `EPOCH ${snapshot.state.admissionEpoch} · ${controlTarget.kind.toUpperCase()} ${shortId(
				controlTarget.id,
				12,
			)} · RECEIPT-GATED`
		: `EPOCH ${snapshot.state.admissionEpoch} · CONTROL CLOSED`;
	elements.controlBarrier.title = controlTarget
		? `Durable admission epoch ${snapshot.state.admissionEpoch}; target ${controlTarget.kind}:${controlTarget.id}; fingerprint ${controlTarget.fingerprint}`
		: `Durable admission epoch ${snapshot.state.admissionEpoch}; no live control target`;
	elements.kernelLabel.textContent = `KERNEL ${snapshot.kernel.pid}`;

	renderControls(mission, campaign);
	renderWorkers(snapshot.workers, verification, snapshot.window);
	renderExperiments(experiments, ideas, generations, campaign, verification);
	renderGenerations(generations, experiments, campaign, verification);
	renderReflection(reflections, generations);
	renderEvents(ledgerEvents);
	const renderedGraphNodes = drawGraph(snapshot.graph);
	renderLineage(
		snapshot.graph,
		campaign,
		currentGeneration,
		experiments,
		ideas,
		generations,
		snapshot.window,
		renderedGraphNodes,
	);
	renderGuidance(snapshot.state.operatorNotes);
	renderCompletion(mission, campaign, experiments);
}

async function refresh() {
	const sequence = ++refreshSequence;
	try {
		const response = await fetch("/api/snapshot", { cache: "no-store" });
		if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
		const nextSnapshot = await response.json();
		const revision = nextSnapshot?.state?.revision;
		if (!Number.isSafeInteger(revision) || revision < 0) {
			throw new Error("Snapshot did not include a valid durable revision.");
		}
		if (
			sequence !== refreshSequence ||
			sequence < appliedRefreshSequence ||
			revision < appliedRevision
		) {
			return;
		}
		appliedRefreshSequence = sequence;
		appliedRevision = revision;
		connectionFailed = false;
		render(nextSnapshot);
		elements.connectionLabel.textContent = connectedLabel();
		elements.connectionPulse.dataset.state = "online";
	} catch (error) {
		if (sequence !== refreshSequence) {
			return;
		}
		elements.connectionLabel.textContent = "LINK LOST";
		elements.connectionPulse.dataset.state = "offline";
		if (!connectionFailed) {
			showToast(messageFor(error));
		}
		connectionFailed = true;
			renderControls(snapshot?.activeMission, snapshot?.activeCampaign);
	}
}

function scheduleRefresh() {
	window.clearTimeout(refreshTimer);
	refreshTimer = window.setTimeout(refresh, 80);
}

function actionId() {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sendControlRequest(path, payload) {
	const stableActionId = actionId();
	const initialTarget = snapshot?.control;
	if (!initialTarget) {
		throw new Error("No active mission or campaign is available. Refresh the dashboard.");
	}
	let transportRetried = false;
	for (let rebaseAttempt = 0; rebaseAttempt < 2; rebaseAttempt += 1) {
		const target = snapshot?.control;
		if (
			!target ||
			target.kind !== initialTarget.kind ||
			target.id !== initialTarget.id
		) {
			throw new Error("The active research target changed; the action was not applied.");
		}
		const envelope = {
			...payload,
			targetKind: target.kind,
			targetId: target.id,
			expectedControlFingerprint: target.fingerprint,
			actionId: stableActionId,
		};
		try {
			const result = await request(path, {
				method: "POST",
				body: JSON.stringify(envelope),
			});
			if (
				result.actionId !== stableActionId ||
				result.targetKind !== target.kind ||
				result.targetId !== target.id ||
				typeof result.actionFingerprint !== "string"
			) {
				throw new Error("The research kernel returned a mismatched control receipt.");
			}
			return result;
		} catch (error) {
			if (!error.status && !transportRetried) {
				transportRetried = true;
				rebaseAttempt -= 1;
				continue;
			}
			if (
				error.status !== 409 ||
				error.body?.code !== "control_precondition_changed" ||
				error.body?.rebaseEligible !== true ||
				rebaseAttempt > 0
			) {
				throw error;
			}
			await refresh();
		}
	}
	throw new Error("The control state kept changing; refresh and try again.");
}

async function control(path, body, successMessage) {
	controlPending = true;
	renderControls(snapshot?.activeMission, snapshot?.activeCampaign);
	try {
		await sendControlRequest(path, body);
		showToast(successMessage);
		scheduleRefresh();
	} catch (error) {
		showToast(messageFor(error));
		scheduleRefresh();
	} finally {
		controlPending = false;
		renderControls(snapshot?.activeMission, snapshot?.activeCampaign);
	}
}

elements.startButton.addEventListener("click", () => {
	const paused = researchIsPaused(snapshot?.activeMission, snapshot?.activeCampaign);
	const route = paused ? "/api/research/resume" : "/api/research/start";
	void control(route, {}, route.endsWith("resume") ? "Research resumed" : "Research started");
});

elements.pauseButton.addEventListener("click", () => {
	void control("/api/research/pause", {}, "Research will pause at the next durable boundary");
});

elements.stopButton.addEventListener("click", () => {
	if (!window.confirm("Stop this campaign? Completed evidence and git branches will be preserved.")) {
		return;
	}
	void control("/api/research/stop", { reason: "Stopped from the ISO dashboard" }, "Campaign stopped");
});

elements.campaignMessageForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const message = elements.campaignMessageInput.value.trim();
	if (!message || notePending) {
		return;
	}
	notePending = true;
	renderControls(snapshot?.activeMission, snapshot?.activeCampaign);
	try {
		await sendControlRequest("/api/note", { message });
		elements.campaignMessageInput.value = "";
		showToast("Guidance queued for the next durable boundary");
		scheduleRefresh();
	} catch (error) {
		showToast(messageFor(error));
		scheduleRefresh();
	} finally {
		notePending = false;
		renderControls(snapshot?.activeMission, snapshot?.activeCampaign);
	}
});

window.addEventListener("resize", () => {
	if (snapshot) drawGraph(snapshot.graph);
});

window.setInterval(() => {
	elements.clock.textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);

const events = new EventSource("/api/events");
events.addEventListener("change", scheduleRefresh);
events.addEventListener("ready", scheduleRefresh);
events.addEventListener("open", () => {
	elements.connectionLabel.textContent = connectedLabel();
	elements.connectionPulse.dataset.state = "online";
	scheduleRefresh();
});
events.addEventListener("error", () => {
	elements.connectionLabel.textContent = "RECONNECTING";
	elements.connectionPulse.dataset.state = "waiting";
});

window.setInterval(() => {
	void refresh();
}, 10_000);
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		void refresh();
	}
});

void refresh();
