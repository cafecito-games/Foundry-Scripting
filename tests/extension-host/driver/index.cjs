const { runScenario } = require("./scenarios.cjs");

async function run() {
  const scenario = process.env.FOUNDRY_E2E_SCENARIO;
  if (!scenario) throw new Error("FOUNDRY_E2E_SCENARIO is required.");
  await runScenario(scenario);
}

module.exports = { run };
