export type SelectionDirection = "maximize" | "minimize";

export type PostSelectionMethod = "paired-bounded-hoeffding-bonferroni-v1" | "paired-student-t-bonferroni-v1";

export type PostSelectionClaimClass = "bounded-independent-trials-fwer" | "assumption-based-paired-student-t";

export interface PostSelectionTrial {
	readonly trialId: string;
	readonly seed: number;
	readonly sampleIndex: number;
	readonly score: number;
}

export interface DeclaredScoreBounds {
	readonly min: number;
	readonly max: number;
}

/**
 * One invocation represents the single fresh post-selection replication block
 * assigned to an opportunity. The caller is responsible for never assigning
 * more than one block to the same opportunity index.
 */
export interface PostSelectionDecisionInput {
	readonly direction: SelectionDirection;
	readonly familyWiseAlpha: number;
	readonly maxOpportunities: number;
	/** One-based index in the campaign's predeclared opportunity budget. */
	readonly opportunityIndex: number;
	readonly threshold: number;
	readonly incumbent: readonly PostSelectionTrial[];
	readonly candidate: readonly PostSelectionTrial[];
	readonly scoreBounds?: DeclaredScoreBounds;
}

export interface PostSelectionEvidence {
	readonly method: PostSelectionMethod;
	readonly claimClass: PostSelectionClaimClass;
	readonly familyWiseAlpha: number;
	readonly adjustedAlpha: number;
	readonly maxOpportunities: number;
	readonly opportunityIndex: number;
	readonly sampleCount: number;
	readonly uncertainty: number;
	readonly lowerBound: number;
	readonly improvement: number;
	readonly threshold: number;
	readonly promoted: boolean;
	readonly assumptions: readonly string[];
}

export class PostSelectionContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PostSelectionContractError";
	}
}

const BOUNDED_ASSUMPTIONS = Object.freeze([
	"Each opportunity uses one fresh post-selection replication block.",
	"The replication outcomes are not observed or used to select the candidate before that block is frozen.",
	"Direction-normalized paired differences are independent across trials.",
	"Every arm score is almost surely contained in the declared finite bounds.",
	"The campaign evaluates no more than its predeclared maximum number of opportunities.",
	"Candidate and incumbent observations are paired by trial ID, seed, and sample index.",
] as const);

const STUDENT_T_ASSUMPTIONS = Object.freeze([
	"Each opportunity uses one fresh post-selection replication block.",
	"The replication outcomes are not observed or used to select the candidate before that block is frozen.",
	"Direction-normalized paired differences are independent and identically distributed.",
	"Paired differences are normally distributed, or the one-sided Student-t approximation is adequate.",
	"The campaign evaluates no more than its predeclared maximum number of opportunities.",
	"This evidence is assumption-based; it is not a distribution-free or universal guarantee.",
] as const);

function requireFinite(value: number, name: string): number {
	if (!Number.isFinite(value)) {
		throw new RangeError(`${name} must be finite.`);
	}
	return value;
}

function requireSafeInteger(value: number, name: string, minimum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
	}
	return value;
}

function validateTrial(trial: PostSelectionTrial, arm: "candidate" | "incumbent", index: number): void {
	if (typeof trial.trialId !== "string" || trial.trialId.trim() === "") {
		throw new PostSelectionContractError(`${arm}[${index}].trialId must be a non-empty string.`);
	}
	requireSafeInteger(trial.seed, `${arm}[${index}].seed`, 0);
	requireSafeInteger(trial.sampleIndex, `${arm}[${index}].sampleIndex`, 0);
	requireFinite(trial.score, `${arm}[${index}].score`);
}

function assertPairedTrials(incumbent: readonly PostSelectionTrial[], candidate: readonly PostSelectionTrial[]): void {
	if (candidate.length !== incumbent.length) {
		throw new PostSelectionContractError(
			`Paired replication arms must have equal sample counts; candidate has ${candidate.length} and incumbent has ${incumbent.length}.`,
		);
	}
	if (candidate.length === 0) {
		throw new RangeError("A post-selection replication block must contain at least one paired sample.");
	}

	const trialIds = new Set<string>();
	const sampleIndices = new Set<number>();
	for (let index = 0; index < candidate.length; index++) {
		const candidateTrial = candidate[index];
		const incumbentTrial = incumbent[index];
		if (candidateTrial === undefined || incumbentTrial === undefined) {
			throw new PostSelectionContractError(`Paired sample ${index} is missing.`);
		}
		validateTrial(candidateTrial, "candidate", index);
		validateTrial(incumbentTrial, "incumbent", index);
		if (
			candidateTrial.trialId !== incumbentTrial.trialId ||
			candidateTrial.seed !== incumbentTrial.seed ||
			candidateTrial.sampleIndex !== incumbentTrial.sampleIndex
		) {
			throw new PostSelectionContractError(`Paired sample ${index} has mismatched trial ID, seed, or sample index.`);
		}
		if (trialIds.has(candidateTrial.trialId)) {
			throw new PostSelectionContractError(
				`Replication trial ID ${JSON.stringify(candidateTrial.trialId)} is not fresh within this block.`,
			);
		}
		if (sampleIndices.has(candidateTrial.sampleIndex)) {
			throw new PostSelectionContractError(
				`Replication sample index ${candidateTrial.sampleIndex} is duplicated within this block.`,
			);
		}
		trialIds.add(candidateTrial.trialId);
		sampleIndices.add(candidateTrial.sampleIndex);
	}
}

function stableMean(values: readonly number[]): number {
	const divisor = values.length;
	let mean = 0;
	let compensation = 0;
	for (const value of values) {
		const term = value / divisor;
		const corrected = term - compensation;
		const next = mean + corrected;
		compensation = next - mean - corrected;
		mean = next;
	}
	if (!Number.isFinite(mean)) {
		throw new RangeError("Paired improvement mean is outside the supported numeric range.");
	}
	return mean;
}

function sampleStandardDeviation(values: readonly number[], mean: number): number {
	let scale = 0;
	for (const value of values) {
		const deviation = Math.abs(value - mean);
		if (!Number.isFinite(deviation)) {
			throw new RangeError("Paired improvement spread is outside the supported numeric range.");
		}
		scale = Math.max(scale, deviation);
	}
	if (scale === 0) {
		return 0;
	}
	let scaledSquares = 0;
	for (const value of values) {
		const scaled = (value - mean) / scale;
		scaledSquares += scaled * scaled;
	}
	const standardDeviation = scale * Math.sqrt(scaledSquares / (values.length - 1));
	if (!Number.isFinite(standardDeviation)) {
		throw new RangeError("Paired improvement standard deviation is outside the supported numeric range.");
	}
	return standardDeviation;
}

// Peter J. Acklam's rational approximation, used to seed the Student-t search.
function inverseStandardNormal(probability: number): number {
	if (!(probability > 0 && probability < 1)) {
		throw new RangeError("Normal probability must be strictly between zero and one.");
	}
	const a = [
		-3.969_683_028_665_376e1, 2.209_460_984_245_205e2, -2.759_285_104_469_687e2, 1.383_577_518_672_69e2,
		-3.066_479_806_614_716e1, 2.506_628_277_459_239,
	] as const;
	const b = [
		-5.447_609_879_822_406e1, 1.615_858_368_580_409e2, -1.556_989_798_598_866e2, 6.680_131_188_771_972e1,
		-1.328_068_155_288_572e1,
	] as const;
	const c = [
		-7.784_894_002_430_293e-3, -3.223_964_580_411_365e-1, -2.400_758_277_161_838, -2.549_732_539_343_734,
		4.374_664_141_464_968, 2.938_163_982_698_783,
	] as const;
	const d = [
		7.784_695_709_041_462e-3, 3.224_671_290_700_398e-1, 2.445_134_137_142_996, 3.754_408_661_907_416,
	] as const;
	const lowerTail = 0.024_25;
	if (probability < lowerTail) {
		const q = Math.sqrt(-2 * Math.log(probability));
		return (
			(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
			((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
		);
	}
	if (probability > 1 - lowerTail) {
		const q = Math.sqrt(-2 * Math.log1p(-probability));
		return -(
			(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
			((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
		);
	}
	const q = probability - 0.5;
	const r = q * q;
	return (
		((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
		(((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
	);
}

function logGamma(value: number): number {
	const coefficients = [
		676.520_368_121_885_1, -1_259.139_216_722_402_8, 771.323_428_777_653_1, -176.615_029_162_140_6,
		12.507_343_278_686_905, -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6, 1.505_632_735_149_311_6e-7,
	] as const;
	if (value < 0.5) {
		return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
	}
	const shifted = value - 1;
	let series = 0.999_999_999_999_809_9;
	for (let index = 0; index < coefficients.length; index++) {
		const coefficient = coefficients[index];
		if (coefficient !== undefined) {
			series += coefficient / (shifted + index + 1);
		}
	}
	const offset = shifted + coefficients.length - 0.5;
	return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(offset) - offset + Math.log(series);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
	const maxIterations = 300;
	const epsilon = 3e-14;
	const minimum = 1e-300;
	const combined = a + b;
	const aPlusOne = a + 1;
	const aMinusOne = a - 1;
	let c = 1;
	let d = 1 - (combined * x) / aPlusOne;
	d = Math.abs(d) < minimum ? minimum : d;
	d = 1 / d;
	let result = d;
	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		const doubled = 2 * iteration;
		let coefficient = (iteration * (b - iteration) * x) / ((aMinusOne + doubled) * (a + doubled));
		d = 1 + coefficient * d;
		d = Math.abs(d) < minimum ? minimum : d;
		c = 1 + coefficient / c;
		c = Math.abs(c) < minimum ? minimum : c;
		d = 1 / d;
		result *= d * c;

		coefficient = (-(a + iteration) * (combined + iteration) * x) / ((a + doubled) * (aPlusOne + doubled));
		d = 1 + coefficient * d;
		d = Math.abs(d) < minimum ? minimum : d;
		c = 1 + coefficient / c;
		c = Math.abs(c) < minimum ? minimum : c;
		d = 1 / d;
		const delta = d * c;
		result *= delta;
		if (Math.abs(delta - 1) <= epsilon) {
			return result;
		}
	}
	throw new RangeError("Student-t quantile did not converge.");
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
	if (x <= 0) {
		return 0;
	}
	if (x >= 1) {
		return 1;
	}
	const leading = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
	if (x < (a + 1) / (a + b + 2)) {
		return (leading * betaContinuedFraction(a, b, x)) / a;
	}
	return 1 - (leading * betaContinuedFraction(b, a, 1 - x)) / b;
}

function studentTUpperTail(value: number, degreesOfFreedom: number): number {
	const ratio = degreesOfFreedom / (degreesOfFreedom + value * value);
	return regularizedIncompleteBeta(ratio, degreesOfFreedom / 2, 0.5) / 2;
}

function studentTUpperCritical(alpha: number, degreesOfFreedom: number): number {
	if (!(alpha > 0 && alpha < 0.5)) {
		throw new RangeError("Adjusted alpha must be strictly between zero and 0.5.");
	}
	requireSafeInteger(degreesOfFreedom, "degreesOfFreedom", 1);
	if (degreesOfFreedom === 1) {
		const critical = 1 / Math.tan(Math.PI * alpha);
		if (!Number.isFinite(critical)) {
			throw new RangeError("Adjusted alpha is too small for a finite Student-t critical value.");
		}
		return critical;
	}

	const z = -inverseStandardNormal(alpha);
	const inverseDegrees = 1 / degreesOfFreedom;
	const z2 = z * z;
	const z3 = z2 * z;
	const z5 = z3 * z2;
	const z7 = z5 * z2;
	const z9 = z7 * z2;
	const approximation =
		z +
		((z3 + z) / 4) * inverseDegrees +
		((5 * z5 + 16 * z3 + 3 * z) / 96) * inverseDegrees ** 2 +
		((3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384) * inverseDegrees ** 3 +
		((79 * z9 + 776 * z7 + 1_482 * z5 - 1_920 * z3 - 945 * z) / 92_160) * inverseDegrees ** 4;
	const maximumInitial = Math.max(1, z) * 1_024;
	let high =
		Number.isFinite(approximation) && approximation > 0 ? Math.min(approximation, maximumInitial) : Math.max(1, z);
	while (studentTUpperTail(high, degreesOfFreedom) > alpha) {
		high *= 2;
		if (!Number.isFinite(high)) {
			throw new RangeError("Adjusted alpha is too small for a finite Student-t critical value.");
		}
	}
	let low = 0;
	for (let iteration = 0; iteration < 160; iteration++) {
		const midpoint = low + (high - low) / 2;
		if (midpoint === low || midpoint === high) {
			break;
		}
		if (studentTUpperTail(midpoint, degreesOfFreedom) > alpha) {
			low = midpoint;
		} else {
			high = midpoint;
		}
	}
	return high;
}

function freezeEvidence(evidence: PostSelectionEvidence): Readonly<PostSelectionEvidence> {
	return Object.freeze({
		...evidence,
		assumptions: Object.freeze([...evidence.assumptions]),
	});
}

export function decidePostSelection(input: PostSelectionDecisionInput): Readonly<PostSelectionEvidence> {
	if (input.direction !== "maximize" && input.direction !== "minimize") {
		throw new RangeError("direction must be either maximize or minimize.");
	}
	const familyWiseAlpha = requireFinite(input.familyWiseAlpha, "familyWiseAlpha");
	if (!(familyWiseAlpha > 0 && familyWiseAlpha < 0.5)) {
		throw new RangeError("familyWiseAlpha must be strictly between zero and 0.5.");
	}
	const maxOpportunities = requireSafeInteger(input.maxOpportunities, "maxOpportunities", 1);
	const opportunityIndex = requireSafeInteger(input.opportunityIndex, "opportunityIndex", 1);
	if (opportunityIndex > maxOpportunities) {
		throw new RangeError("opportunityIndex must not exceed maxOpportunities.");
	}
	const threshold = requireFinite(input.threshold, "threshold");
	if (threshold < 0) {
		throw new RangeError("threshold must be greater than or equal to zero.");
	}
	assertPairedTrials(input.incumbent, input.candidate);

	const differences = input.candidate.map((candidateTrial, index) => {
		const incumbentTrial = input.incumbent[index];
		if (incumbentTrial === undefined) {
			throw new PostSelectionContractError(`Incumbent sample ${index} is missing.`);
		}
		const difference =
			input.direction === "maximize"
				? candidateTrial.score - incumbentTrial.score
				: incumbentTrial.score - candidateTrial.score;
		if (!Number.isFinite(difference)) {
			throw new RangeError(
				`Direction-normalized paired difference ${index} is outside the supported numeric range.`,
			);
		}
		return difference;
	});
	const improvement = stableMean(differences);
	const adjustedAlpha = familyWiseAlpha / maxOpportunities;
	if (!(adjustedAlpha > 0 && Number.isFinite(adjustedAlpha))) {
		throw new RangeError("Bonferroni-adjusted alpha is outside the supported numeric range.");
	}

	if (input.scoreBounds !== undefined) {
		const minimum = requireFinite(input.scoreBounds.min, "scoreBounds.min");
		const maximum = requireFinite(input.scoreBounds.max, "scoreBounds.max");
		if (!(minimum < maximum)) {
			throw new RangeError("scoreBounds.min must be strictly less than scoreBounds.max.");
		}
		const range = maximum - minimum;
		if (!Number.isFinite(range)) {
			throw new RangeError("Declared score range is outside the supported numeric range.");
		}
		for (let index = 0; index < input.candidate.length; index++) {
			const candidateScore = input.candidate[index]?.score;
			const incumbentScore = input.incumbent[index]?.score;
			if (
				candidateScore === undefined ||
				incumbentScore === undefined ||
				candidateScore < minimum ||
				candidateScore > maximum ||
				incumbentScore < minimum ||
				incumbentScore > maximum
			) {
				throw new RangeError(`Paired sample ${index} contains a score outside the declared bounds.`);
			}
		}
		const uncertainty = range * Math.sqrt((2 * Math.log(maxOpportunities / familyWiseAlpha)) / differences.length);
		const lowerBound = improvement - uncertainty;
		if (!Number.isFinite(uncertainty) || !Number.isFinite(lowerBound)) {
			throw new RangeError("Bounded Hoeffding evidence is outside the supported numeric range.");
		}
		return freezeEvidence({
			method: "paired-bounded-hoeffding-bonferroni-v1",
			claimClass: "bounded-independent-trials-fwer",
			familyWiseAlpha,
			adjustedAlpha,
			maxOpportunities,
			opportunityIndex,
			sampleCount: differences.length,
			uncertainty,
			lowerBound,
			improvement,
			threshold,
			promoted: improvement > 0 && lowerBound >= threshold,
			assumptions: BOUNDED_ASSUMPTIONS,
		});
	}

	if (differences.length < 2) {
		throw new RangeError("Assumption-based paired Student-t evidence requires at least two paired samples.");
	}
	const standardDeviation = sampleStandardDeviation(differences, improvement);
	const critical = studentTUpperCritical(adjustedAlpha, differences.length - 1);
	const uncertainty = critical * (standardDeviation / Math.sqrt(differences.length));
	if (!Number.isFinite(uncertainty)) {
		throw new RangeError("Student-t uncertainty is outside the supported numeric range.");
	}
	const lowerBound = improvement - uncertainty;
	if (!Number.isFinite(lowerBound)) {
		throw new RangeError("Student-t lower bound is outside the supported numeric range.");
	}
	return freezeEvidence({
		method: "paired-student-t-bonferroni-v1",
		claimClass: "assumption-based-paired-student-t",
		familyWiseAlpha,
		adjustedAlpha,
		maxOpportunities,
		opportunityIndex,
		sampleCount: differences.length,
		uncertainty,
		lowerBound,
		improvement,
		threshold,
		promoted: improvement > 0 && lowerBound >= threshold,
		assumptions: STUDENT_T_ASSUMPTIONS,
	});
}
