const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const request = require("supertest");

const {
    generateSigningKeys,
    raPrivateKeyPath,
    raPublicKeyPath,
} = require("../ra/tokenService");
const { createApp } = require("../ra/server");
const {
    getDb,
    insertElection,
    deleteElection,
    getToken,
} = require("../common/db");

const db = getDb();
const electionId = "e1";
const cliPath = path.resolve(__dirname, "../ra/cli.js");

const ensureElection = () => {
    deleteElection(electionId);
    db.prepare("DELETE FROM tokens WHERE electionId = ?").run(electionId);

    insertElection({
        id: electionId,
        title: "RA Test Election",
        startIso: "2025-01-01T00:00:00.000Z",
        endIso: "2025-12-31T23:59:59.000Z",
        choices: ["Yes", "No"],
    });
};

describe("registration authority workflows", () => {
    beforeAll(() => {
        generateSigningKeys();
        expect(fs.existsSync(raPrivateKeyPath)).toBe(true);
        expect(fs.existsSync(raPublicKeyPath)).toBe(true);
    });

    beforeEach(() => {
        ensureElection();
    });

    test("CLI issues token and persists record", () => {
        const result = spawnSync(
            process.execPath,
            [cliPath, "issue-token", "--election", electionId, "--voter", "v1"],
            {
                encoding: "utf8",
                cwd: process.cwd(),
                env: { ...process.env },
            }
        );

        if (result.status !== 0) {
            throw new Error(`CLI failed: ${result.stderr}`);
        }

        const row = db
            .prepare(
                "SELECT tokenId, electionId, voterId, tokenJwt, used FROM tokens WHERE electionId = ? AND voterId = ? ORDER BY issuedAt DESC"
            )
            .get(electionId, "v1");

        expect(row).toBeDefined();
        expect(row.used).toBe(0);
        expect(typeof row.tokenJwt).toBe("string");
        expect(row.tokenJwt.length).toBeGreaterThan(100);
    });

    test("RA server issues token and exposes lookup", async () => {
        const app = createApp();

        const issueResponse = await request(app)
            .post("/issue-token")
            .send({ electionId, voterId: "v2" })
            .expect(201);

        const { tokenId, tokenJwt } = issueResponse.body;
        expect(tokenId).toBeDefined();
        expect(tokenJwt).toBeDefined();

        const record = getToken(tokenId);
        expect(record).toBeDefined();
        expect(record.used).toBe(0);

        const fetchResponse = await request(app)
            .get(`/token/${tokenId}`)
            .expect(200);

        expect(fetchResponse.body.tokenId).toBe(tokenId);
        expect(fetchResponse.body.voterId).toBe("v2");
    });
});
