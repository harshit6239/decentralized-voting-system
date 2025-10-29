const fs = require("fs");
const path = require("path");
const { generateKeyPairSync } = require("crypto");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const { resolved } = require("../common/config");
const { ensureDir, writeJson, readJson, nowISO } = require("../common/utils");
const { getElection, insertToken, getToken } = require("../common/db");

const RA_PRIVATE_FILENAME = "ra-sign-priv.json";
const RA_PUBLIC_FILENAME = "ra-sign-pub.json";

const raPrivateKeyPath = path.join(resolved.KEYS_DIR, RA_PRIVATE_FILENAME);
const raPublicKeyPath = path.join(resolved.KEYS_DIR, RA_PUBLIC_FILENAME);
const tokensDir = path.resolve(process.cwd(), "data", "tokens");
const SIGNING_ALGORITHM = "RS256";

const ensureKeysDir = () => {
    ensureDir(raPrivateKeyPath);
    ensureDir(raPublicKeyPath);
};

const generateSigningKeys = ({ force = false } = {}) => {
    ensureKeysDir();

    const privateExists = fs.existsSync(raPrivateKeyPath);
    const publicExists = fs.existsSync(raPublicKeyPath);

    if (!force && privateExists && publicExists) {
        return {
            privateKeyPath: raPrivateKeyPath,
            publicKeyPath: raPublicKeyPath,
        };
    }

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const privatePem =
        typeof privateKey === "string"
            ? privateKey
            : privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem =
        typeof publicKey === "string"
            ? publicKey
            : publicKey.export({ type: "spki", format: "pem" });

    const createdAt = nowISO();

    writeJson(raPrivateKeyPath, {
        type: "rsa",
        algorithm: SIGNING_ALGORITHM,
        format: "pem",
        key: privatePem,
        createdAt,
    });

    writeJson(raPublicKeyPath, {
        type: "rsa",
        algorithm: SIGNING_ALGORITHM,
        format: "pem",
        key: publicPem,
        createdAt,
    });

    return { privateKeyPath: raPrivateKeyPath, publicKeyPath: raPublicKeyPath };
};

const loadSigningKey = () => {
    if (!fs.existsSync(raPrivateKeyPath)) {
        throw new Error("RA signing key not found; run 'gen-keys' first.");
    }

    const keyData = readJson(raPrivateKeyPath);
    return keyData.key;
};

const loadPublicKey = () => {
    if (!fs.existsSync(raPublicKeyPath)) {
        throw new Error("RA public key not found; run 'gen-keys' first.");
    }

    const keyData = readJson(raPublicKeyPath);
    return keyData.key;
};

const issueToken = ({ electionId, voterId }) => {
    if (!electionId || !voterId) {
        throw new Error("Both electionId and voterId are required");
    }

    const election = getElection(electionId);

    if (!election) {
        throw new Error(`Election '${electionId}' not found`);
    }

    const privateKeyPem = loadSigningKey();
    const tokenId = uuidv4();

    const expirationSeconds = Math.floor(
        new Date(election.end_iso).getTime() / 1000
    );

    if (!Number.isFinite(expirationSeconds)) {
        throw new Error(`Invalid election end date '${election.end_iso}'`);
    }

    const payload = {
        tokenId,
        electionId,
        voterId,
        exp: expirationSeconds,
        electionEndsAt: election.end_iso,
    };

    const tokenJwt = jwt.sign(payload, privateKeyPem, {
        algorithm: SIGNING_ALGORITHM,
    });

    const issuedAt = nowISO();

    insertToken({
        tokenId,
        electionId,
        voterId,
        tokenJwt,
        used: 0,
        issuedAt,
    });

    const tokenFilePath = path.join(tokensDir, `${tokenId}.jwt`);
    ensureDir(tokenFilePath);
    fs.writeFileSync(tokenFilePath, `${tokenJwt}\n`, "utf8");

    return {
        tokenId,
        tokenJwt,
        tokenFilePath,
        issuedAt,
    };
};

module.exports = {
    generateSigningKeys,
    issueToken,
    loadSigningKey,
    loadPublicKey,
    raPrivateKeyPath,
    raPublicKeyPath,
    tokensDir,
    getToken,
    SIGNING_ALGORITHM,
};
