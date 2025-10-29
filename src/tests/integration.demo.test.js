jest.setTimeout(15000);

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { runDemoInProcess } = require("../../scripts/demo_inprocess");
const { cleanDemo } = require("../../scripts/cleanup");
const { getDb } = require("../common/db");

const resolvePath = (relativePath) => path.resolve(process.cwd(), relativePath);

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

describe("in-process demo integration", () => {
    test("runs end-to-end without external services", async () => {
        const { result, electionId } = await runDemoWithRetries();

        const expectedVotes = result.voters.length;

        expect(result.ledgerEntries.length).toBe(expectedVotes);
        expect(result.tokens.length).toBe(expectedVotes);
        expect(result.tokens.every((token) => token.used === 1)).toBe(true);

        expect(result.tally.totalVotes).toBe(expectedVotes);
        const expectedCounts = result.voters.reduce((acc, voter) => {
            acc[voter.choice] = (acc[voter.choice] || 0) + 1;
            return acc;
        }, {});

        const actualCounts = result.tally.results.reduce((acc, item) => {
            acc[item.choiceId] = item.count;
            return acc;
        }, {});

        expect(actualCounts).toEqual(expectedCounts);

        expect(result.auditReport.status).toBe("PASS");
        expect(result.auditReport.passCount).toBe(
            result.auditReport.sampleSize
        );

        const db = getDb();
        const ledgerCount = db
            .prepare(
                "SELECT COUNT(1) as count FROM ledger WHERE electionId = ?"
            )
            .get(result.electionId).count;
        expect(ledgerCount).toBe(expectedVotes);

        result.artifacts.cipherFiles.forEach((relative) => {
            expect(fs.existsSync(resolvePath(relative))).toBe(true);
        });

        result.artifacts.vvpatFiles.forEach((relative) => {
            expect(fs.existsSync(resolvePath(relative))).toBe(true);
        });

        if (result.artifacts.tallyFile) {
            expect(fs.existsSync(resolvePath(result.artifacts.tallyFile))).toBe(
                true
            );
        }

        if (result.artifacts.auditReportFile) {
            expect(
                fs.existsSync(resolvePath(result.artifacts.auditReportFile))
            ).toBe(true);
        }

        cleanDemo({ quiet: true, electionId });
    });
});
