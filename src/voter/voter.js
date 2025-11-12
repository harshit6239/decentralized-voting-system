/**
 * Voter utility library for key management, ballot preparation, and submission workflows.
 * All functions are synchronous or promise-based so they can be consumed directly by the CLI or tests.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const {
    genKeypair,
    encryptWithPublicKey,
    computeCommitment,
    constants,
} = require("../common/crypto");
const { ensureDir, readJson, writeJson, nowISO } = require("../common/utils");
const { resolved } = require("../common/config");

const DEFAULT_LEDGER_URL = () => {
    const port = process.env.PORT_LEDGER || "4000";
    return `http://localhost:${port}/submit`;
};

const KEYS_DIR = resolved.KEYS_DIR;
const VVPAT_DIR = path.resolve(process.cwd(), "src", "terminal_vvpats");

/**
 * Derive friendly voter key filenames from a voter identifier.
 * @param {string} voterId
 * @returns {{ publicKeyPath: string, privateKeyPath: string }}
 */
const voterKeyPaths = (voterId) => ({
    publicKeyPath: path.join(KEYS_DIR, `voter-${voterId}-pub.json`),
    privateKeyPath: path.join(KEYS_DIR, `voter-${voterId}-priv.json`),
});

/**
 * Generate a signing keypair for a voter and persist the keys on disk.
 * Uses the shared crypto key generation helper to ensure consistent encoding.
 * @param {string} voterId
 * @returns {{ publicKeyPath: string, privateKeyPath: string }}
 */
const generateVoterKeys = (voterId) => {
    if (!voterId) {
        throw new Error("voterId is required");
    }

    const keyLabel = `voter-${voterId}`;
    const generatedPaths = genKeypair(keyLabel);
    const ed25519Path = generatedPaths[constants.KEY_ALGO_SIGN];

    const ed25519Key = readJson(ed25519Path);
    const { publicKeyPath, privateKeyPath } = voterKeyPaths(voterId);

    ensureDir(publicKeyPath);
    ensureDir(privateKeyPath);

    writeJson(publicKeyPath, {
        voterId,
        type: "ed25519",
        publicKey: ed25519Key.publicKey,
        createdAt: ed25519Key.createdAt,
    });

    writeJson(privateKeyPath, {
        voterId,
        type: "ed25519",
        secretKey: ed25519Key.secretKey,
        createdAt: ed25519Key.createdAt,
    });

    return { publicKeyPath, privateKeyPath };
};

/**
 * Construct a plain ballot payload with consistent timestamping.
 * @param {string} electionId
 * @param {string} voterId
 * @param {string} choice
 * @returns {{ electionId: string, voterId: string, choice: string, timestamp: string }}
 */
const buildBallotPlain = (electionId, voterId, choice) => {
    if (!electionId || !voterId || !choice) {
        throw new Error(
            "electionId, voterId, and choice are required to build a ballot"
        );
    }

    return {
        electionId,
        voterId,
        choice,
        timestamp: nowISO(),
    };
};

/**
 * Encrypt a ballot object using the election's public key file.
 * @param {Record<string, any>} ballotPlain
 * @param {string} electionPublicKeyFile path to JSON file containing the election public key
 * @returns {{ ciphertextB64: string, nonceB64: string, commitmentHex: string }}
 */
const encryptBallot = (ballotPlain, electionPublicKeyFile) => {
    if (!ballotPlain) {
        throw new Error("ballotPlain is required");
    }

    if (!electionPublicKeyFile) {
        throw new Error("electionPublicKeyFile is required");
    }

    const { voterId: _omittedVoter, ...anonymousBallot } = ballotPlain;
    const plaintext = JSON.stringify(anonymousBallot);
    const { ciphertextBase64, nonceBase64 } = encryptWithPublicKey(
        plaintext,
        electionPublicKeyFile
    );
    const commitmentHex = computeCommitment(ciphertextBase64, nonceBase64);

    return {
        ciphertextB64: ciphertextBase64,
        nonceB64: nonceBase64,
        commitmentHex,
    };
};

/**
 * Submit a ballot to the ledger endpoint with a bounded timeout.
 * @param {Record<string, any>} ballotSubmission
 * @param {string} [ledgerURL]
 * @returns {Promise<Record<string, any>>}
 */
const submitBallot = async (ballotSubmission, ledgerURL) => {
    if (!ballotSubmission) {
        throw new Error("ballotSubmission payload is required");
    }

    const targetUrl = (
        ledgerURL ||
        process.env.LEDGER_URL ||
        DEFAULT_LEDGER_URL()
    ).replace(/\/$/, "");

    try {
        const response = await axios.post(targetUrl, ballotSubmission, {
            timeout: 5000,
            headers: {
                "Content-Type": "application/json",
            },
        });

        return response.data;
    } catch (error) {
        if (error.code === "ECONNABORTED") {
            throw new Error("Ballot submission timed out after 5s");
        }

        const message =
            error.response?.data?.message ||
            error.message ||
            "Ledger submission failed";
        throw new Error(message);
    }
};

/**
 * Persist a VVPAT style audit artifact for the cast ballot.
 * @param {string} commitmentHex
 * @param {Record<string, any>} ballotPlain
 * @param {Record<string, any>} receipt
 * @returns {string} filepath to stored VVPAT file
 */
const recordVvpat = (commitmentHex, ballotPlain, receipt) => {
    const vvpatPath = path.join(VVPAT_DIR, `${commitmentHex}.json`);
    ensureDir(vvpatPath);
    const { voterId: _omittedForRecord, ...anonymousBallot } = ballotPlain;
    const entry = {
        ballotPlain: anonymousBallot,
        receipt,
        timestamp: nowISO(),
    };
    fs.writeFileSync(vvpatPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return vvpatPath;
};

module.exports = {
    generateVoterKeys,
    buildBallotPlain,
    encryptBallot,
    submitBallot,
    recordVvpat,
    voterKeyPaths,
    DEFAULT_LEDGER_URL,
};
