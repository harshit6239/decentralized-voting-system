jest.setTimeout(15000);

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { cleanDemo } = require("../../scripts/cleanup");
const { runDemoInProcess } = require("../../scripts/demo_inprocess");
const { getDb } = require("../common/db");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const CIPHER_DIR = path.join(DATA_DIR, "ciphers");
const TOKENS_DIR = path.join(DATA_DIR, "tokens");
const LEDGER_LOG_PATH = path.join(DATA_DIR, "ledger.jsonl");
const VVPAT_DIR = path.join(PROJECT_ROOT, "src", "terminal_vvpats");
const resolvePath = (relativePath) =>
    path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(PROJECT_ROOT, relativePath);

const MAX_ATTEMPTS = 3;

const runDemoWithRetries = async () => {
    let attempt = 0;
    let electionId = `demo-${randomUUID()}`;

    while (attempt < MAX_ATTEMPTS) {
        cleanDemo({ quiet: true, electionId });
        try {
            const result = await runDemoInProcess({
                quiet: true,
                electionId,
            });
            return { result, electionId };
        } catch (error) {
            const shouldRetry =
                /already used/i.test(error?.message || "") &&
                attempt < MAX_ATTEMPTS - 1;

            if (!shouldRetry) {
                throw error;
            }

            cleanDemo({ quiet: true, electionId });
            attempt += 1;
            electionId = `demo-${randomUUID()}`;
        }
    }

    throw new Error("runDemoWithRetries exhausted attempts");
};

describe("cleanup utility", () => {
    test("removes demo artifacts and resets persistent state", async () => {
        const { result, electionId } = await runDemoWithRetries();

        const db = getDb();
        const ledgerBefore = db
            .prepare(
                "SELECT COUNT(1) as count FROM ledger WHERE electionId = ?"
            )
            .get(electionId).count;
        expect(ledgerBefore).toBeGreaterThan(0);

        const tokensBefore = db
            .prepare(
                "SELECT COUNT(1) as count FROM tokens WHERE electionId = ?"
            )
            .get(electionId).count;
        expect(tokensBefore).toBeGreaterThan(0);

        const summary = cleanDemo({ quiet: true, electionId });

        const ledgerAfter = db
            .prepare(
                "SELECT COUNT(1) as count FROM ledger WHERE electionId = ?"
            )
            .get(electionId).count;
        const tokensAfter = db
            .prepare(
                "SELECT COUNT(1) as count FROM tokens WHERE electionId = ?"
            )
            .get(electionId).count;

        expect(ledgerAfter).toBe(0);
        expect(tokensAfter).toBe(0);

        result.artifacts.cipherFiles.forEach((relativePath) => {
            expect(fs.existsSync(resolvePath(relativePath))).toBe(false);
        });

        result.tokens.forEach((token) => {
            const tokenPath = path.join(TOKENS_DIR, `${token.tokenId}.jwt`);
            expect(fs.existsSync(tokenPath)).toBe(false);
        });

        const vvpatFilesRemaining = fs.existsSync(VVPAT_DIR)
            ? fs.readdirSync(VVPAT_DIR).filter(
                  (file) =>
                      file.endsWith(".json") &&
                      (() => {
                          try {
                              const content = JSON.parse(
                                  fs.readFileSync(
                                      path.join(VVPAT_DIR, file),
                                      "utf8"
                                  )
                              );
                              return (
                                  content?.ballotPlain?.electionId ===
                                  electionId
                              );
                          } catch (error) {
                              return false;
                          }
                      })()
              )
            : [];
        expect(vvpatFilesRemaining).toHaveLength(0);

        if (fs.existsSync(LEDGER_LOG_PATH)) {
            const logContents = fs.readFileSync(LEDGER_LOG_PATH, "utf8");
            expect(logContents.includes(electionId)).toBe(false);
        }

        expect(summary.electionId).toBe(electionId);
        expect(summary.ledgerRowsCleared).toBeGreaterThan(0);
        expect(summary.tokensCleared).toBeGreaterThan(0);
        expect(summary.cipherFilesRemoved.length).toBe(
            result.ledgerEntries.length
        );
        expect(summary.tokenFilesRemoved.length).toBe(result.tokens.length);
        expect(summary.ledgerLogEntriesRemoved).toBeGreaterThan(0);
    });
});
