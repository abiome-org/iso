import { createHash } from "node:crypto";
import { getActiveCampaign, getActiveMission } from "./store.ts";
import type { Campaign, IsoState, MissionPhase, ProposedIdea, ResearchMission } from "./types.ts";

export type ControlTargetKind = "mission" | "campaign";

export interface ControlTarget {
	kind: ControlTargetKind;
	id: string;
	fingerprint: string;
}

export interface ControlContext {
	target: ControlTarget;
	mission?: ResearchMission;
	campaign?: Campaign;
}

export type ResearchControlAction =
	| { kind: "start" }
	| { kind: "resume" }
	| { kind: "pause" }
	| { kind: "stop"; reason: string }
	| { kind: "note"; message: string; hypothesis?: ProposedIdea };

export interface ResearchControlRequest {
	actionId: string;
	actionFingerprint: string;
	targetKind: ControlTargetKind;
	targetId: string;
	expectedControlFingerprint: string;
	action: ResearchControlAction;
}

export type ResearchControlOutcome =
	| {
			kind: "start" | "resume";
			missionResumed: boolean;
			missionPhase?: MissionPhase;
			started: boolean;
			runId: string;
			missionId?: string;
			campaignId?: string;
	  }
	| {
			kind: "pause";
			paused: true;
			missionId?: string;
			campaignId?: string;
	  }
	| {
			kind: "stop";
			stopped: true;
			missionId?: string;
			campaignId?: string;
	  }
	| {
			kind: "note";
			queued: true;
			noteId: string;
			missionId?: string;
			campaignId?: string;
	  };

export interface ResearchControlReceipt {
	actionId: string;
	actionFingerprint: string;
	targetKind: ControlTargetKind;
	targetId: string;
	acceptedControlFingerprint: string;
	revision: number;
	outcome: ResearchControlOutcome;
}

export type ControlConflictCode = "no_control_target" | "control_target_changed" | "control_precondition_changed";

export class ControlConflictError extends Error {
	readonly code: ControlConflictCode;
	readonly revision: number;
	readonly activeControl?: ControlTarget;
	readonly rebaseEligible: boolean;

	constructor(options: {
		code: ControlConflictCode;
		message: string;
		revision: number;
		activeControl?: ControlTarget;
		rebaseEligible?: boolean;
	}) {
		super(options.message);
		this.name = "ControlConflictError";
		this.code = options.code;
		this.revision = options.revision;
		this.activeControl = options.activeControl;
		this.rebaseEligible = options.rebaseEligible ?? false;
	}
}

export function isTerminalMission(mission: ResearchMission): boolean {
	return ["completed", "stopped", "failed"].includes(mission.phase);
}

export function isTerminalCampaign(campaign: Campaign): boolean {
	return ["completed", "stopped", "failed"].includes(campaign.status);
}

export function campaignControlState(campaign: Campaign): "paused" | "ready" | "running" | "terminal" {
	if (isTerminalCampaign(campaign)) {
		return "terminal";
	}
	if (campaign.runIntent === "paused" || ["paused", "pausing"].includes(campaign.status)) {
		return "paused";
	}
	return campaign.status === "ready" ? "ready" : "running";
}

export function controlTargetForEntities(
	mission: ResearchMission | undefined,
	campaign: Campaign | undefined,
): ControlTarget | undefined {
	if (mission && !isTerminalMission(mission)) {
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					kind: "mission",
					id: mission.id,
					desiredState: mission.desiredState,
					campaignId: mission.campaignId,
					campaignControlState: campaign ? campaignControlState(campaign) : "pending",
				}),
			)
			.digest("base64url");
		return { kind: "mission", id: mission.id, fingerprint };
	}
	if (campaign && !isTerminalCampaign(campaign)) {
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					kind: "campaign",
					id: campaign.id,
					campaignControlState: campaignControlState(campaign),
				}),
			)
			.digest("base64url");
		return { kind: "campaign", id: campaign.id, fingerprint };
	}
	return undefined;
}

export function controlContextForState(state: IsoState): ControlContext | undefined {
	const mission = getActiveMission(state);
	if (mission) {
		const campaign = mission.campaignId
			? state.campaigns.find((candidate) => candidate.id === mission.campaignId)
			: undefined;
		const target = controlTargetForEntities(mission, campaign);
		return target ? { target, mission, campaign } : undefined;
	}
	const campaign = getActiveCampaign(state);
	const target = controlTargetForEntities(undefined, campaign);
	return target && campaign ? { target, campaign } : undefined;
}

export function controlActionCanRebase(action: ResearchControlAction["kind"]): boolean {
	return action === "note" || action === "stop";
}

export function assertControlPrecondition(state: IsoState, request: ResearchControlRequest): ControlContext {
	const context = controlContextForState(state);
	if (!context) {
		throw new ControlConflictError({
			code: "no_control_target",
			message: "There is no active mission or campaign to control.",
			revision: state.revision,
		});
	}
	if (context.target.kind !== request.targetKind || context.target.id !== request.targetId) {
		throw new ControlConflictError({
			code: "control_target_changed",
			message: "The active research target changed. Refresh before issuing another control action.",
			revision: state.revision,
			activeControl: context.target,
		});
	}
	if (context.target.fingerprint !== request.expectedControlFingerprint) {
		const rebaseEligible = controlActionCanRebase(request.action.kind);
		throw new ControlConflictError({
			code: "control_precondition_changed",
			message: rebaseEligible
				? "The research control state changed. ISO can safely rebase this action after refresh."
				: "The research control state changed. Refresh and confirm this action again.",
			revision: state.revision,
			activeControl: context.target,
			rebaseEligible,
		});
	}
	return context;
}
