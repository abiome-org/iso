import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Campaign, CampaignConfig, Idea, IsoEvent, IsoState, MetricDefinition, ProposedIdea } from "./types.ts";

const EMPTY_STATE: IsoState = {
	schemaVersion: 1,
	campaigns: [],
	ideas: [],
	experiments: [],
	events: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isIsoState(value: unknown): value is IsoState {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		Array.isArray(value.campaigns) &&
		Array.isArray(value.ideas) &&
		Array.isArray(value.experiments) &&
		Array.isArray(value.events)
	);
}

function cloneState(state: IsoState): IsoState {
	return structuredClone(state);
}

export function now(): string {
	return new Date().toISOString();
}

export function makeId(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export class IsoStore {
	readonly repoRoot: string;
	readonly statePath: string;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(repoRoot: string) {
		this.repoRoot = repoRoot;
		this.statePath = join(repoRoot, ".iso", "state.json");
	}

	async exists(): Promise<boolean> {
		try {
			await readFile(this.statePath, "utf8");
			return true;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") {
				return false;
			}
			throw error;
		}
	}

	async read(): Promise<IsoState> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
			if (!isIsoState(parsed)) {
				throw new Error(`Invalid ISO state at ${this.statePath}`);
			}
			return cloneState(parsed);
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") {
				return cloneState(EMPTY_STATE);
			}
			throw error;
		}
	}

	async update<T>(mutate: (state: IsoState) => T | Promise<T>): Promise<T> {
		const operation = this.writeQueue.then(async () => {
			const state = await this.read();
			const result = await mutate(state);
			await this.write(state);
			return result;
		});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async initialize(options: { goal: string; metric: MetricDefinition; config: CampaignConfig }): Promise<Campaign> {
		return this.update((state) => {
			const active = getActiveCampaign(state);
			if (active) {
				throw new Error(`ISO is already initialized with campaign ${active.id}`);
			}
			const timestamp = now();
			const campaign: Campaign = {
				id: makeId("campaign"),
				goal: options.goal,
				metric: options.metric,
				config: options.config,
				status: "draft",
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			state.campaigns.push(campaign);
			state.events.push(
				createEvent(campaign.id, "campaign.created", `Campaign created: ${campaign.goal}`, "human", [campaign.id]),
			);
			return structuredClone(campaign);
		});
	}

	async addIdea(campaignId: string, proposal: ProposedIdea, source: Idea["source"] = "human"): Promise<Idea> {
		return this.update((state) => {
			const timestamp = now();
			const idea: Idea = {
				id: makeId("idea"),
				campaignId,
				title: proposal.title,
				hypothesis: proposal.hypothesis,
				implementationPlan: proposal.implementationPlan,
				status: "queued",
				source,
				parentIdeaIds: proposal.parentIdeaIds ?? [],
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			state.ideas.push(idea);
			state.events.push(
				createEvent(campaignId, "idea.proposed", `Idea proposed: ${idea.title}`, source, [
					idea.id,
					...idea.parentIdeaIds,
				]),
			);
			return structuredClone(idea);
		});
	}

	private async write(state: IsoState): Promise<void> {
		await mkdir(dirname(this.statePath), { recursive: true });
		const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, this.statePath);
	}
}

export function getActiveCampaign(state: IsoState): Campaign | undefined {
	return state.campaigns
		.slice()
		.reverse()
		.find((campaign) => campaign.status !== "completed" && campaign.status !== "failed");
}

export function createEvent(
	campaignId: string,
	type: string,
	summary: string,
	actor: IsoEvent["actor"],
	refs: string[] = [],
): IsoEvent {
	return {
		id: makeId("event"),
		campaignId,
		type,
		summary,
		actor,
		at: now(),
		refs,
	};
}
