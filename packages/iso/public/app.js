const token = window.ISO_CONTROL_TOKEN;
const elements = {
	campaignGoal: document.querySelector("#campaign-goal"),
	campaignStatus: document.querySelector("#campaign-status"),
	championScore: document.querySelector("#champion-score"),
	metricLabel: document.querySelector("#metric-label"),
	experimentCount: document.querySelector("#experiment-count"),
	experimentDetail: document.querySelector("#experiment-detail"),
	ideaCount: document.querySelector("#idea-count"),
	ideaDetail: document.querySelector("#idea-detail"),
	workerCount: document.querySelector("#worker-count"),
	workerList: document.querySelector("#worker-list"),
	ideaTable: document.querySelector("#idea-table"),
	eventList: document.querySelector("#event-list"),
	graph: document.querySelector("#idea-graph"),
	graphEmpty: document.querySelector("#graph-empty"),
	runButton: document.querySelector("#run-button"),
	pauseButton: document.querySelector("#pause-button"),
	iterations: document.querySelector("#iterations"),
	workers: document.querySelector("#workers"),
	newIdeaButton: document.querySelector("#new-idea-button"),
	ideaDialog: document.querySelector("#idea-dialog"),
	ideaForm: document.querySelector("#idea-form"),
	closeDialog: document.querySelector("#close-dialog"),
	cancelDialog: document.querySelector("#cancel-dialog"),
	toast: document.querySelector("#toast"),
	connectionLabel: document.querySelector("#connection-label"),
	clock: document.querySelector("#clock"),
};

let snapshot;
let refreshTimer;

function showToast(message) {
	elements.toast.textContent = message;
	elements.toast.classList.add("visible");
	window.setTimeout(() => elements.toast.classList.remove("visible"), 2800);
}

async function request(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: {
			"content-type": "application/json",
			"x-iso-control-token": token,
			...options.headers,
		},
	});
	const body = await response.json();
	if (!response.ok) {
		throw new Error(body.error || `Request failed: ${response.status}`);
	}
	return body;
}

function timeLabel(value) {
	const date = new Date(value);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status) {
	const span = document.createElement("span");
	span.className = "status-badge";
	span.textContent = status.toUpperCase();
	return span;
}

function renderWorkers(workers) {
	elements.workerCount.textContent = `${workers.length} ACTIVE`;
	elements.workerList.replaceChildren();
	if (workers.length === 0) {
		const empty = document.createElement("p");
		empty.className = "empty-copy";
		empty.textContent = "No active agents. Start a research pass to spin up the harness.";
		elements.workerList.append(empty);
		return;
	}
	for (const worker of workers) {
		const card = document.createElement("article");
		card.className = "worker-card";
		const header = document.createElement("header");
		const title = document.createElement("h3");
		title.textContent = worker.label;
		header.append(title, statusBadge(worker.status));
		const activity = document.createElement("p");
		activity.textContent = `${worker.activity} · ${timeLabel(worker.startedAt)}`;
		const controls = document.createElement("div");
		controls.className = "worker-controls";
		const input = document.createElement("input");
		input.placeholder = "Steer this agent…";
		input.setAttribute("aria-label", `Steer ${worker.label}`);
		const steer = document.createElement("button");
		steer.className = "button";
		steer.type = "button";
		steer.textContent = "SEND";
		steer.addEventListener("click", async () => {
			if (!input.value.trim()) return;
			try {
				await request(`/api/workers/${worker.id}/steer`, {
					method: "POST",
					body: JSON.stringify({ message: input.value.trim() }),
				});
				input.value = "";
				showToast("Steering message queued");
			} catch (error) {
				showToast(error.message);
			}
		});
		const abort = document.createElement("button");
		abort.className = "button button-danger";
		abort.type = "button";
		abort.textContent = "STOP";
		abort.addEventListener("click", async () => {
			try {
				await request(`/api/workers/${worker.id}/abort`, {
					method: "POST",
					body: "{}",
				});
				showToast("Abort requested");
			} catch (error) {
				showToast(error.message);
			}
		});
		controls.append(input, steer, abort);
		card.append(header, activity, controls);
		elements.workerList.append(card);
	}
}

function renderIdeas(ideas) {
	elements.ideaTable.replaceChildren();
	for (const idea of ideas.slice().reverse()) {
		const row = document.createElement("tr");
		const status = document.createElement("td");
		status.append(statusBadge(idea.status));
		const title = document.createElement("td");
		title.textContent = idea.title;
		title.title = idea.hypothesis;
		const source = document.createElement("td");
		source.textContent = idea.source.toUpperCase();
		const created = document.createElement("td");
		created.textContent = timeLabel(idea.createdAt);
		row.append(status, title, source, created);
		elements.ideaTable.append(row);
	}
}

function renderEvents(events) {
	elements.eventList.replaceChildren();
	for (const event of events.slice(-30).reverse()) {
		const item = document.createElement("li");
		const time = document.createElement("time");
		time.dateTime = event.at;
		time.textContent = timeLabel(event.at);
		const content = document.createElement("div");
		const summary = document.createElement("p");
		summary.textContent = event.summary;
		const meta = document.createElement("small");
		meta.textContent = `${event.actor.toUpperCase()} / ${event.type}`;
		content.append(summary, meta);
		item.append(time, content);
		elements.eventList.append(item);
	}
}

function graphColors(node) {
	if (node.kind === "campaign") return ["#eeefe8", "#0a0b0a"];
	if (node.kind === "idea") return ["#79a7ff", "#0a0b0a"];
	if (node.kind === "experiment") return ["#ffbd59", "#0a0b0a"];
	return ["#b7f44a", "#0a0b0a"];
}

function truncate(value, limit) {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function drawGraph(graph) {
	const canvas = elements.graph;
	const rect = canvas.getBoundingClientRect();
	const ratio = window.devicePixelRatio || 1;
	canvas.width = Math.round(rect.width * ratio);
	canvas.height = Math.round(rect.height * ratio);
	const context = canvas.getContext("2d");
	context.scale(ratio, ratio);
	context.clearRect(0, 0, rect.width, rect.height);
	elements.graphEmpty.hidden = graph.nodes.length > 1;
	if (graph.nodes.length === 0) return;

	const columns = {
		campaign: rect.width * 0.1,
		idea: rect.width * 0.34,
		experiment: rect.width * 0.64,
		result: rect.width * 0.88,
	};
	const positions = new Map();
	for (const kind of ["campaign", "idea", "experiment", "result"]) {
		const nodes = graph.nodes.filter((node) => node.kind === kind);
		nodes.forEach((node, index) => {
			positions.set(node.id, {
				x: columns[kind],
				y: ((index + 1) * rect.height) / (nodes.length + 1),
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
		context.strokeStyle = edge.kind === "champions" ? "#b7f44a" : "#3a4038";
		context.setLineDash(edge.kind === "derived-from" ? [4, 5] : []);
		context.stroke();
	}
	context.setLineDash([]);

	for (const node of graph.nodes) {
		const position = positions.get(node.id);
		if (!position) continue;
		const [fill, text] = graphColors(node);
		const radius = node.kind === "campaign" ? 12 : node.kind === "result" ? 11 : 9;
		context.beginPath();
		context.arc(position.x, position.y, radius, 0, Math.PI * 2);
		context.fillStyle = fill;
		context.fill();
		context.fillStyle = text;
		context.font = "600 8px SFMono-Regular, monospace";
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(node.kind.slice(0, 1).toUpperCase(), position.x, position.y + 0.5);
		context.fillStyle = "#eeefe8";
		context.font = "500 10px SFMono-Regular, monospace";
		context.textAlign = "center";
		context.textBaseline = "top";
		context.fillText(truncate(node.label, 24), position.x, position.y + radius + 8);
	}
}

function render(nextSnapshot) {
	snapshot = nextSnapshot;
	const campaign = snapshot.activeCampaign;
	const ideas = campaign
		? snapshot.state.ideas.filter((idea) => idea.campaignId === campaign.id)
		: [];
	const experiments = campaign
		? snapshot.state.experiments.filter((experiment) => experiment.campaignId === campaign.id)
		: [];
	const champion = experiments.find((experiment) => experiment.id === campaign?.championExperimentId);
	elements.campaignGoal.textContent = campaign?.goal || "Run iso init to define the research mission";
	elements.campaignStatus.textContent = campaign?.status.toUpperCase() || "OFFLINE";
	elements.championScore.textContent = champion?.evaluation?.score ?? "—";
	elements.metricLabel.textContent = campaign
		? `${campaign.metric.direction.toUpperCase()} ${campaign.metric.name.toUpperCase()}`
		: "NO METRIC";
	elements.experimentCount.textContent = experiments.length;
	elements.experimentDetail.textContent = `${experiments.filter((item) => item.evaluation).length} measured`;
	elements.ideaCount.textContent = ideas.length;
	elements.ideaDetail.textContent = `${ideas.filter((idea) => idea.status === "queued").length} queued`;
	if (campaign) {
		elements.iterations.value = campaign.config.defaultIterations;
		elements.workers.value = campaign.config.defaultWorkers;
	}
	renderWorkers(snapshot.workers);
	renderIdeas(ideas);
	renderEvents(snapshot.state.events.filter((event) => !campaign || event.campaignId === campaign.id));
	drawGraph(snapshot.graph);
}

async function refresh() {
	try {
		const response = await fetch("/api/snapshot", { cache: "no-store" });
		if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
		render(await response.json());
		elements.connectionLabel.textContent = "LOCAL LINK";
	} catch (error) {
		elements.connectionLabel.textContent = "LINK LOST";
		showToast(error.message);
	}
}

function scheduleRefresh() {
	window.clearTimeout(refreshTimer);
	refreshTimer = window.setTimeout(refresh, 80);
}

elements.runButton.addEventListener("click", async () => {
	try {
		await request("/api/research/start", {
			method: "POST",
			body: JSON.stringify({
				iterations: Number(elements.iterations.value),
				workers: Number(elements.workers.value),
			}),
		});
		showToast("Research loop started");
		scheduleRefresh();
	} catch (error) {
		showToast(error.message);
	}
});

elements.pauseButton.addEventListener("click", async () => {
	try {
		await request("/api/research/pause", { method: "POST", body: "{}" });
		showToast("Campaign will pause after active work settles");
		scheduleRefresh();
	} catch (error) {
		showToast(error.message);
	}
});

elements.newIdeaButton.addEventListener("click", () => elements.ideaDialog.showModal());
elements.closeDialog.addEventListener("click", () => elements.ideaDialog.close());
elements.cancelDialog.addEventListener("click", () => elements.ideaDialog.close());
elements.ideaForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const data = new FormData(elements.ideaForm);
	try {
		await request("/api/ideas", {
			method: "POST",
			body: JSON.stringify({
				title: data.get("title"),
				hypothesis: data.get("hypothesis"),
				implementationPlan: data.get("implementationPlan"),
			}),
		});
		elements.ideaDialog.close();
		elements.ideaForm.reset();
		showToast("Idea queued");
		scheduleRefresh();
	} catch (error) {
		showToast(error.message);
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
events.addEventListener("open", () => {
	elements.connectionLabel.textContent = "LOCAL LINK";
});
events.addEventListener("error", () => {
	elements.connectionLabel.textContent = "RECONNECTING";
});

refresh();
