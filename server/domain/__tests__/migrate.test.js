import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-migrate-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(ROOT, ".secrets-key");

const { runMigrations } = await import("../migrate.js");
const { hasRecipeSecret } = await import("../../secretsStore.js");

function v1Fixture(dir) {
  const modelsPath = path.join(dir, "models.json");
  const recipesPath = path.join(dir, "recipes.json");
  const deploymentsPath = path.join(dir, "deployments.json");
  fs.writeFileSync(
    modelsPath,
    JSON.stringify(
      { models: [{ id: "m1", name: "Model One", family: "F", archived: false, createdAt: 1, updatedAt: 1 }] },
      null,
      2
    )
  );
  fs.writeFileSync(
    recipesPath,
    JSON.stringify(
      {
        recipes: [
          {
            id: "r1",
            modelId: "m1",
            name: "Recipe One",
            runtime: "tabbyapi-exl3",
            topology: "single",
            nodeIds: ["node-7"],
            modelPath: "/models/one",
            workdir: "/w",
            apiPort: 9200,
            healthPath: "/v1/models",
            contextLength: 32768,
            cpuAffinity: "1-2",
            launcher: "python main.py",
            env: [{ name: "OPEN_TOKEN", value: "sekret", secret: true }],
            notes: "n",
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
      null,
      2
    )
  );
  return { modelsPath, recipesPath, deploymentsPath };
}

test("v1 fixture migrates to byte-stable v2 + backup + secret move + deploy binding", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "case"));
  const paths = v1Fixture(dir);

  assert.equal(runMigrations(paths).migrated, true);

  // Backups written.
  assert.ok(fs.existsSync(`${paths.modelsPath}.v1.bak`));
  assert.ok(fs.existsSync(`${paths.recipesPath}.v1.bak`));

  const models = JSON.parse(fs.readFileSync(paths.modelsPath, "utf8"));
  const recipes = JSON.parse(fs.readFileSync(paths.recipesPath, "utf8"));
  const deps = JSON.parse(fs.readFileSync(paths.deploymentsPath, "utf8"));

  assert.equal(models.schemaVersion, 2);
  assert.equal(recipes.schemaVersion, 2);
  assert.equal(deps.schemaVersion, 2);

  // recipe.modelPath moved to the model's weightPaths.default.
  assert.equal(models.models[0].weightPaths.default, "/models/one");
  // nodeIds moved to a seed deployment.
  assert.deepEqual(deps.deployments.map((d) => d.nodeIds), [["node-7"]]);
  assert.equal(deps.deployments[0].recipeId, "r1");

  // structured blocks + no raw secret value in the recipe file.
  assert.equal(recipes.recipes[0].engine.runtime, "tabbyapi-exl3");
  assert.equal(recipes.recipes[0].endpoint.port, 9200);
  assert.equal(recipes.recipes[0].launch.affinity, "1-2");
  const secretEntry = recipes.recipes[0].launch.env.find((e) => e.name === "OPEN_TOKEN");
  assert.equal(secretEntry.secretRef, "recipe:r1:OPEN_TOKEN");
  assert.ok(!JSON.stringify(recipes).includes("sekret"));
  assert.ok(hasRecipeSecret("recipe:r1:OPEN_TOKEN"));

  // Byte-stable + idempotent on a second run.
  const before = {
    m: fs.readFileSync(paths.modelsPath, "utf8"),
    r: fs.readFileSync(paths.recipesPath, "utf8"),
    d: fs.readFileSync(paths.deploymentsPath, "utf8"),
  };
  assert.equal(runMigrations(paths).migrated, false);
  assert.equal(fs.readFileSync(paths.modelsPath, "utf8"), before.m);
  assert.equal(fs.readFileSync(paths.recipesPath, "utf8"), before.r);
  assert.equal(fs.readFileSync(paths.deploymentsPath, "utf8"), before.d);
});

test("migration of an already-v2 file is a no-op and keeps no backup churn", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "v2"));
  const paths = v1Fixture(dir);
  runMigrations(paths);
  const bakTime = fs.statSync(`${paths.recipesPath}.v1.bak`).mtimeMs;
  runMigrations(paths);
  assert.equal(fs.statSync(`${paths.recipesPath}.v1.bak`).mtimeMs, bakTime);
});
