import assert from "node:assert/strict";
import test from "node:test";
import {
	type DeclaredScoreBounds,
	decidePostSelection,
	type PostSelectionDecisionInput,
	type PostSelectionTrial,
} from "../src/selection.ts";

function pairedTrials(
	incumbentScores: readonly number[],
	candidateScores: readonly number[],
): Pick<PostSelectionDecisionInput, "candidate" | "incumbent"> {
	assert.equal(candidateScores.length, incumbentScores.length);
	const incumbent: PostSelectionTrial[] = [];
	const candidate: PostSelectionTrial[] = [];
	for (let index = 0; index < incumbentScores.length; index++) {
		const identity = {
			trialId: `fresh-trial-${index}`,
			seed: 10_000 + index,
			sampleIndex: index,
		};
		incumbent.push({ ...identity, score: incumbentScores[index] ?? Number.NaN });
		candidate.push({ ...identity, score: candidateScores[index] ?? Number.NaN });
	}
	return { incumbent, candidate };
}

function decisionInput(
	incumbentScores: readonly number[],
	candidateScores: readonly number[],
	overrides: Partial<PostSelectionDecisionInput> = {},
): PostSelectionDecisionInput {
	return {
		direction: "maximize",
		familyWiseAlpha: 0.05,
		maxOpportunities: 10,
		opportunityIndex: 1,
		threshold: 0,
		...pairedTrials(incumbentScores, candidateScores),
		...overrides,
	};
}

test("uses the specified paired bounded Hoeffding Bonferroni gate", () => {
	const scoreBounds: DeclaredScoreBounds = { min: 0, max: 1 };
	const evidence = decidePostSelection(
		decisionInput([0, 0, 0, 0], [1, 1, 1, 1], {
			familyWiseAlpha: 0.05,
			maxOpportunities: 5,
			opportunityIndex: 3,
			threshold: 0.1,
			scoreBounds,
		}),
	);
	const expectedRadius = Math.sqrt((2 * Math.log(5 / 0.05)) / 4);
	assert.equal(evidence.method, "paired-bounded-hoeffding-bonferroni-v1");
	assert.equal(evidence.claimClass, "bounded-independent-trials-fwer");
	assert.equal(evidence.adjustedAlpha, 0.01);
	assert.equal(evidence.improvement, 1);
	assert.equal(evidence.uncertainty, expectedRadius);
	assert.equal(evidence.lowerBound, 1 - expectedRadius);
	assert.equal(evidence.opportunityIndex, 3);
	assert.equal(evidence.sampleCount, 4);
	assert.equal(evidence.promoted, false);
	assert.ok(Object.isFrozen(evidence));
	assert.ok(Object.isFrozen(evidence.assumptions));
});

test("normalizes minimize-direction improvements before making a decision", () => {
	const evidence = decidePostSelection(
		decisionInput([10, 12, 11, 9, 13], [8, 10, 9, 7, 11.1], {
			direction: "minimize",
			maxOpportunities: 1,
			threshold: 1,
		}),
	);
	assert.equal(Math.abs(evidence.improvement - 1.98) < 1e-12, true);
	assert.equal(evidence.uncertainty > 0, true);
	assert.equal(evidence.lowerBound > 1, true);
	assert.equal(evidence.promoted, true);
});

test("computes a one-sided paired Student-t interval at adjusted alpha", () => {
	const evidence = decidePostSelection(
		decisionInput([0, 0, 0], [1, 2, 3], {
			maxOpportunities: 1,
		}),
	);
	const expectedCritical = 2.919_985_580_353_724;
	const expectedUncertainty = expectedCritical / Math.sqrt(3);
	assert.equal(Math.abs(evidence.improvement - 2) < 1e-12, true);
	assert.equal(Math.abs(evidence.uncertainty - expectedUncertainty) < 1e-10, true);
});

test("Bonferroni multiplicity makes both bounded and Student-t gates more conservative", () => {
	const boundedOne = decidePostSelection(
		decisionInput([0, 0, 0], [1, 1, 1], {
			maxOpportunities: 1,
			scoreBounds: { min: 0, max: 1 },
		}),
	);
	const boundedMany = decidePostSelection(
		decisionInput([0, 0, 0], [1, 1, 1], {
			maxOpportunities: 100,
			scoreBounds: { min: 0, max: 1 },
		}),
	);
	assert.equal(boundedOne.adjustedAlpha, 0.05);
	assert.equal(boundedMany.adjustedAlpha, 0.0005);
	assert.equal(boundedMany.uncertainty > boundedOne.uncertainty, true);

	const studentOne = decidePostSelection(decisionInput([0, 0, 0, 0, 0], [1, 2, 1, 2, 1], { maxOpportunities: 1 }));
	const studentMany = decidePostSelection(decisionInput([0, 0, 0, 0, 0], [1, 2, 1, 2, 1], { maxOpportunities: 100 }));
	assert.equal(studentMany.uncertainty > studentOne.uncertainty, true);
});

test("handles zero paired variance and accepts an exactly met positive threshold", () => {
	const accepted = decidePostSelection(decisionInput([4, 7, 9], [6, 9, 11], { threshold: 1 }));
	assert.equal(accepted.uncertainty, 0);
	assert.equal(accepted.lowerBound, 2);
	assert.equal(accepted.promoted, true);

	const boundary = decidePostSelection(decisionInput([4, 7, 9], [6, 9, 11], { threshold: 2 }));
	assert.equal(boundary.lowerBound, 2);
	assert.equal(boundary.promoted, true);

	const neutral = decidePostSelection(decisionInput([4, 7, 9], [4, 7, 9], { threshold: 0 }));
	assert.equal(neutral.promoted, false);
});

test("rejects scores outside declared finite bounds", () => {
	assert.throws(
		() =>
			decidePostSelection(
				decisionInput([0.2, 0.3], [0.4, 1.01], {
					scoreBounds: { min: 0, max: 1 },
				}),
			),
		/outside the declared bounds/,
	);
	for (const scoreBounds of [
		{ min: Number.NEGATIVE_INFINITY, max: 1 },
		{ min: 0, max: Number.POSITIVE_INFINITY },
		{ min: 1, max: 1 },
		{ min: 2, max: 1 },
	]) {
		assert.throws(
			() => decidePostSelection(decisionInput([0, 0], [1, 1], { scoreBounds })),
			/scoreBounds|strictly less/,
		);
	}
});

test("rejects every form of paired identity mismatch", () => {
	for (const field of ["trialId", "seed", "sampleIndex"] as const) {
		const input = decisionInput([0, 0], [1, 1]);
		const original = input.candidate[1];
		assert.ok(original);
		const replacement =
			field === "trialId"
				? { ...original, trialId: "different" }
				: field === "seed"
					? { ...original, seed: original.seed + 1 }
					: { ...original, sampleIndex: original.sampleIndex + 1 };
		assert.throws(
			() => decidePostSelection({ ...input, candidate: [input.candidate[0] as PostSelectionTrial, replacement] }),
			/mismatched trial ID, seed, or sample index/,
		);
	}
	const unequal = decisionInput([0, 0], [1, 1]);
	assert.throws(
		() => decidePostSelection({ ...unequal, candidate: [unequal.candidate[0] as PostSelectionTrial] }),
		/Paired replication arms must have equal sample counts/,
	);
});

test("rejects reused trial identities and sample indices inside a replication block", () => {
	const input = decisionInput([0, 0], [1, 1]);
	const firstIncumbent = input.incumbent[0];
	const firstCandidate = input.candidate[0];
	const secondIncumbent = input.incumbent[1];
	const secondCandidate = input.candidate[1];
	assert.ok(firstIncumbent && firstCandidate && secondIncumbent && secondCandidate);
	assert.throws(
		() =>
			decidePostSelection({
				...input,
				incumbent: [firstIncumbent, { ...secondIncumbent, trialId: firstIncumbent.trialId }],
				candidate: [firstCandidate, { ...secondCandidate, trialId: firstCandidate.trialId }],
			}),
		/not fresh within this block/,
	);
	assert.throws(
		() =>
			decidePostSelection({
				...input,
				incumbent: [firstIncumbent, { ...secondIncumbent, sampleIndex: firstIncumbent.sampleIndex }],
				candidate: [firstCandidate, { ...secondCandidate, sampleIndex: firstCandidate.sampleIndex }],
			}),
		/duplicated within this block/,
	);
});

test("rejects invalid sample counts, alpha, opportunity budget, threshold, and observations", () => {
	assert.throws(
		() => decidePostSelection(decisionInput([], [], { scoreBounds: { min: 0, max: 1 } })),
		/at least one paired sample/,
	);
	assert.throws(() => decidePostSelection(decisionInput([0], [1])), /requires at least two paired samples/);
	for (const familyWiseAlpha of [0, -0.01, 0.5, 1, Number.NaN]) {
		assert.throws(() => decidePostSelection(decisionInput([0, 0], [1, 1], { familyWiseAlpha })), /familyWiseAlpha/);
	}
	for (const maxOpportunities of [0, -1, 1.5, Number.MAX_VALUE]) {
		assert.throws(() => decidePostSelection(decisionInput([0, 0], [1, 1], { maxOpportunities })), /maxOpportunities/);
	}
	assert.throws(() => decidePostSelection(decisionInput([0, 0], [1, 1], { opportunityIndex: 11 })), /must not exceed/);
	assert.throws(() => decidePostSelection(decisionInput([0, 0], [1, 1], { threshold: -1 })), /threshold/);
	assert.throws(() => decidePostSelection(decisionInput([0, 0], [1, Number.NaN])), /must be finite/);
});

test("unbounded evidence states assumptions and never claims a universal guarantee", () => {
	const evidence = decidePostSelection(decisionInput([1, 1, 1], [2, 3, 2]));
	assert.equal(evidence.method, "paired-student-t-bonferroni-v1");
	assert.equal(evidence.claimClass, "assumption-based-paired-student-t");
	assert.equal(evidence.claimClass.includes("fwer"), false);
	assert.equal(
		evidence.assumptions.some((assumption) => assumption.includes("not a distribution-free or universal")),
		true,
	);
});
