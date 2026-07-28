import assert from "node:assert/strict";
import test from "node:test";
import { runEvaluator } from "../src/evaluator.ts";

test("parses the ISO_RESULT evaluator contract", async () => {
	const evaluation = await runEvaluator(
		`node -e 'console.log(JSON.stringify({score:7.5,metrics:{cost:2}}))'`,
		process.cwd(),
	);
	assert.equal(evaluation.score, 7.5);
	assert.equal(evaluation.metrics.cost, 2);
});
