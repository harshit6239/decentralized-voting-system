jest.setTimeout(10000);

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

jest.mock("axios", () => ({
    post: jest.fn(),
}));

const axios = require("axios");

const {
    generateVoterKeys,
    buildBallotPlain,
    encryptBallot,
    submitBallot,
    voterKeyPaths,
    DEFAULT_LEDGER_URL,
} = require("../voter/voter");
const { genKeypair, constants } = require("../common/crypto");
const { readJson, writeJson, nowISO } = require("../common/utils");

const electionPubPath = path.resolve(
    process.cwd(),
    "src",
    "keys",
    "election-pub.json"
);
const vvpatDir = path.resolve(process.cwd(), "src", "terminal_vvpats");
const mockTokenPath = path.resolve(__dirname, "mock.token");
const axiosCapturePath = path.resolve(__dirname, "__tmp__", "axios-call.json");

const ensureElectionKey = () => {
    if (fs.existsSync(electionPubPath)) {
        return;
    }

    const electionKeys = genKeypair("election-pub");
    const boxInfo = readJson(electionKeys[constants.KEY_ALGO_BOX]);
    writeJson(electionPubPath, {
        name: "election-pub",
        type: constants.KEY_ALGO_BOX,
        publicKey: boxInfo.publicKey,
        createdAt: boxInfo.createdAt,
    });
};

const removeIfExists = (targetPath) => {
    try {
        fs.rmSync(targetPath, { force: true, recursive: true });
    } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EBUSY") {
            throw error;
        }
    }
};

const clearDirectory = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    fs.readdirSync(dirPath).forEach((entry) => {
        const target = path.join(dirPath, entry);
        const stats = fs.statSync(target);
        if (stats.isDirectory()) {
            clearDirectory(target);
            try {
                fs.rmdirSync(target);
            } catch (error) {
                if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
                    throw error;
                }
            }
        } else {
            fs.unlinkSync(target);
        }
    });
};

describe("voter workflow", () => {
    beforeAll(() => {
        ensureElectionKey();
    });

    afterAll(() => {
        removeIfExists(mockTokenPath);
        removeIfExists(axiosCapturePath);
    });

    beforeEach(() => {
        const paths = voterKeyPaths("v1");
        removeIfExists(paths.publicKeyPath);
        removeIfExists(paths.privateKeyPath);

        removeIfExists(mockTokenPath);
        removeIfExists(axiosCapturePath);

        clearDirectory(vvpatDir);

        axios.post.mockReset();
    });

    test("core helpers generate keys, encrypt ballot, and submit", async () => {
        const keyPaths = generateVoterKeys("v1");
        expect(fs.existsSync(keyPaths.publicKeyPath)).toBe(true);
        expect(fs.existsSync(keyPaths.privateKeyPath)).toBe(true);

        const ballotPlain = buildBallotPlain("e1", "v1", "ChoiceA");
        expect(ballotPlain).toMatchObject({
            electionId: "e1",
            voterId: "v1",
            choice: "ChoiceA",
        });

        const seal = encryptBallot(ballotPlain, electionPubPath);
        expect(seal.ciphertextB64).toBeDefined();
        expect(seal.commitmentHex).toHaveLength(64);

        const fakeReceipt = {
            receiptId: "R1",
            ledgerIndex: 1,
            commitment: seal.commitmentHex,
            timestamp: nowISO(),
            signature: "sig",
        };

        axios.post.mockResolvedValue({ data: fakeReceipt });

        const submission = {
            tokenJwt: "header.payload.signature",
            ciphertextB64: seal.ciphertextB64,
            nonceB64: seal.nonceB64,
            commitmentHex: seal.commitmentHex,
            electionId: "e1",
            timestamp: ballotPlain.timestamp,
        };

        const response = await submitBallot(submission, DEFAULT_LEDGER_URL());
        expect(response).toEqual(fakeReceipt);
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test("CLI cast command submits ballot and writes VVPAT", () => {
        generateVoterKeys("v1");

        const header = Buffer.from(
            JSON.stringify({ alg: "none", typ: "JWT" })
        ).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ voterId: "v1" })).toString(
            "base64url"
        );
        const token = `${header}.${payload}.sig`;
        fs.writeFileSync(mockTokenPath, `${token}\n`, "utf8");

        const cliPath = path.resolve(process.cwd(), "src", "voter", "cli.js");
        const supportMockPath = path.resolve(
            __dirname,
            "support",
            "axios-mock-cli.js"
        );

        const vvpatBefore = fs.existsSync(vvpatDir)
            ? new Set(fs.readdirSync(vvpatDir))
            : new Set();

        const receiptStub = {
            receiptId: "R1",
            ledgerIndex: 1,
            commitment: "demo-commitment",
            timestamp: "2025-01-01T00:00:00Z",
            signature: "sig",
        };

        const spawnResult = spawnSync(
            process.execPath,
            [
                "-r",
                supportMockPath,
                cliPath,
                "cast",
                "--election",
                "e1",
                "--token-file",
                mockTokenPath,
                "--choice",
                "A",
                "--voter",
                "v1",
            ],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    LEDGER_URL: "http://localhost:4000",
                    MOCK_RECEIPT_JSON: JSON.stringify(receiptStub),
                    AXIOS_MOCK_OUTFILE: axiosCapturePath,
                },
                encoding: "utf8",
            }
        );

        if (spawnResult.error) {
            throw spawnResult.error;
        }

        expect(spawnResult.status).toBe(0);

        expect(fs.existsSync(axiosCapturePath)).toBe(true);
        const capturedCall = JSON.parse(
            fs.readFileSync(axiosCapturePath, "utf8")
        );
        expect(capturedCall.url).toBe("http://localhost:4000/submit");

        const vvpatAfter = fs.existsSync(vvpatDir)
            ? fs.readdirSync(vvpatDir)
            : [];
        const newFiles = vvpatAfter.filter(
            (file) => file.endsWith(".json") && !vvpatBefore.has(file)
        );
        expect(newFiles.length).toBeGreaterThan(0);

        const vvpatContent = JSON.parse(
            fs.readFileSync(path.join(vvpatDir, newFiles[0]), "utf8")
        );
        expect(vvpatContent.receipt).toEqual(receiptStub);
        expect(vvpatContent.ballotPlain.electionId).toBe("e1");
        expect(vvpatContent.ballotPlain.voterId).toBe("v1");
    });
});
