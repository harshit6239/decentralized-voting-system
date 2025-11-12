const fs = require("fs");
const path = require("path");
const { createHash, randomBytes } = require("crypto");
const nacl = require("tweetnacl");
const naclUtil = require("tweetnacl-util");
const {
    generateRandomKeysSync,
    PublicKey: PaillierPublicKey,
    PrivateKey: PaillierPrivateKey,
} = require("paillier-bigint");
const {
    split: splitSecret,
    combine: combineShares,
} = require("shamirs-secret-sharing");

const { KEYS_DIR, resolved } = require("./config");
const {
    readJson,
    writeJson,
    nowISO,
    toBase64,
    fromBase64,
} = require("./utils");

const KEY_ALGO_BOX = "paillier";
const KEY_ALGO_SIGN = "ed25519";

const SHARE_TOTAL = Number(process.env.PAILLIER_SHARE_TOTAL || 3);
const SHARE_THRESHOLD = Number(process.env.PAILLIER_SHARE_THRESHOLD || 2);

if (!Number.isInteger(SHARE_TOTAL) || SHARE_TOTAL < 1) {
    throw new Error("PAILLIER_SHARE_TOTAL must be a positive integer");
}

if (!Number.isInteger(SHARE_THRESHOLD) || SHARE_THRESHOLD < 1) {
    throw new Error("PAILLIER_SHARE_THRESHOLD must be a positive integer");
}

if (SHARE_THRESHOLD > SHARE_TOTAL) {
    throw new Error(
        "PAILLIER_SHARE_THRESHOLD cannot exceed PAILLIER_SHARE_TOTAL"
    );
}

const SHARE_SUBDIR = "shares";

const keysRoot = resolved.KEYS_DIR;

const resolveKeyFile = (filePath) => {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }

    return path.resolve(keysRoot, filePath);
};

const ensureKeysDir = () => {
    fs.mkdirSync(keysRoot, { recursive: true });
};

const asUint8 = (input) => {
    if (input instanceof Uint8Array) {
        return input;
    }

    if (Buffer.isBuffer(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (Array.isArray(input)) {
        return Uint8Array.from(input);
    }

    throw new TypeError("Unable to convert input to Uint8Array");
};

const normalizeHex = (hex) => (hex.length % 2 === 0 ? hex : `0${hex}`);

const bigIntToBase64 = (value) => {
    if (value === 0n) {
        return Buffer.from([0]).toString("base64");
    }

    const hex = normalizeHex(value.toString(16));
    return Buffer.from(hex, "hex").toString("base64");
};

const base64ToBigInt = (b64) => {
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length === 0) {
        return 0n;
    }

    const hex = buffer.toString("hex") || "00";
    return BigInt(`0x${hex}`);
};

const bigIntToUtf8 = (value) => {
    if (value === 0n) {
        return "";
    }

    const hex = normalizeHex(value.toString(16));
    const buffer = Buffer.from(hex, "hex");
    return buffer.toString("utf8");
};

const utf8ToBigInt = (text) => {
    if (!text || text.length === 0) {
        return 0n;
    }

    const buffer = Buffer.from(text, "utf8");
    const hex = buffer.toString("hex");
    return BigInt(`0x${hex || "00"}`);
};

const bigIntToBuffer = (value) => {
    if (value === 0n) {
        return Buffer.from([0]);
    }

    const hex = normalizeHex(value.toString(16));
    return Buffer.from(hex, "hex");
};

const bufferToBigInt = (buffer) => {
    if (!buffer || buffer.length === 0) {
        return 0n;
    }

    return BigInt(`0x${buffer.toString("hex") || "00"}`);
};

const loadPaillierPublicKey = (keyData) => {
    const publicKeyData = keyData?.publicKey;

    if (!publicKeyData) {
        throw new Error(
            "Homomorphic public key material missing; regenerate keys for this election"
        );
    }

    if (typeof publicKeyData === "object" && publicKeyData.n) {
        const n = BigInt(publicKeyData.n);
        const g = publicKeyData.g ? BigInt(publicKeyData.g) : n + 1n;
        return new PaillierPublicKey(n, g);
    }

    throw new Error("Unsupported Paillier public key format");
};

const readPaillierKeyMaterial = (keyPath) => {
    const keyData = readJson(keyPath);

    if (!keyData || typeof keyData !== "object") {
        throw new Error("Invalid key file format");
    }

    const publicKey = loadPaillierPublicKey(keyData);

    return {
        keyData,
        publicKey,
    };
};

const resolveSharePath = (keyPath, sharePath) => {
    if (!sharePath) {
        throw new Error("Paillier share path is required");
    }

    if (path.isAbsolute(sharePath)) {
        return sharePath;
    }

    const keyDir = path.dirname(keyPath);
    const candidate = path.resolve(keyDir, sharePath);
    if (fs.existsSync(candidate)) {
        return candidate;
    }

    return path.resolve(keysRoot, sharePath);
};

const loadShareDescriptor = (keyPath, descriptor) => {
    if (typeof descriptor === "string") {
        const resolved = resolveSharePath(keyPath, descriptor);
        return {
            ...readJson(resolved),
            __source: resolved,
        };
    }

    if (descriptor && typeof descriptor === "object") {
        if (descriptor.path) {
            const resolved = resolveSharePath(keyPath, descriptor.path);
            return {
                ...readJson(resolved),
                __source: resolved,
            };
        }

        if (descriptor.lambdaShareB64 && descriptor.muShareB64) {
            return descriptor;
        }
    }

    throw new Error("Unsupported Paillier share descriptor");
};

const collectSharePayloads = (keyPath, keyData, shareInputs = []) => {
    const thresholdInfo = keyData.threshold;

    if (!thresholdInfo) {
        return [];
    }

    const required = Number(thresholdInfo.requiredShares || SHARE_THRESHOLD);
    const candidates =
        Array.isArray(shareInputs) && shareInputs.length
            ? shareInputs
            : thresholdInfo.shareFiles || [];

    if (!Array.isArray(candidates) || candidates.length < required) {
        throw new Error(
            `At least ${required} Paillier key shares are required for decryption`
        );
    }

    const seen = new Set();
    const payloads = [];

    for (const descriptor of candidates) {
        const payload = loadShareDescriptor(keyPath, descriptor);

        if (!payload?.lambdaShareB64 || !payload?.muShareB64) {
            throw new Error("Invalid Paillier share payload");
        }

        const shareIndex =
            payload.index ??
            payload.shareIndex ??
            payload.id ??
            payload.identifier;

        if (shareIndex !== undefined) {
            if (seen.has(shareIndex)) {
                continue;
            }
            seen.add(shareIndex);
        }

        payloads.push(payload);

        if (payloads.length >= required) {
            break;
        }
    }

    if (payloads.length < required) {
        throw new Error(
            `Insufficient unique Paillier shares supplied (required ${required})`
        );
    }

    return payloads;
};

const reconstructPaillierPrivateKey = (
    keyPath,
    keyData,
    publicKey,
    shareInputs
) => {
    if (keyData.privateKey && keyData.privateKey.lambda) {
        const lambda = BigInt(keyData.privateKey.lambda);
        const mu = BigInt(keyData.privateKey.mu);
        const p = keyData.privateKey.p
            ? BigInt(keyData.privateKey.p)
            : undefined;
        const q = keyData.privateKey.q
            ? BigInt(keyData.privateKey.q)
            : undefined;
        return new PaillierPrivateKey(lambda, mu, publicKey, p, q);
    }

    if (!keyData.threshold) {
        return null;
    }

    const payloads = collectSharePayloads(keyPath, keyData, shareInputs);

    const lambdaBuffer = combineShares(
        payloads.map((item) => Buffer.from(item.lambdaShareB64, "base64"))
    );
    const muBuffer = combineShares(
        payloads.map((item) => Buffer.from(item.muShareB64, "base64"))
    );

    const lambda = bufferToBigInt(lambdaBuffer);
    const mu = bufferToBigInt(muBuffer);

    return new PaillierPrivateKey(lambda, mu, publicKey);
};

const genKeypair = (name) => {
    ensureKeysDir();

    const { publicKey, privateKey } = generateRandomKeysSync(2048, true);
    const signKeyPair = nacl.sign.keyPair();

    const timestamp = nowISO();

    const boxKeyPath = path.join(keysRoot, `${name}-${KEY_ALGO_BOX}.json`);
    const signKeyPath = path.join(keysRoot, `${name}-${KEY_ALGO_SIGN}.json`);

    const shareOptions = {
        shares: SHARE_TOTAL,
        threshold: SHARE_THRESHOLD,
    };

    const lambdaShares = splitSecret(bigIntToBuffer(privateKey.lambda), {
        ...shareOptions,
    });
    const muShares = splitSecret(bigIntToBuffer(privateKey.mu), {
        ...shareOptions,
    });

    const shareDir = path.join(path.dirname(boxKeyPath), SHARE_SUBDIR, name);

    const shareFiles = lambdaShares.map((lambdaShare, index) => {
        const muShare = muShares[index];
        if (!muShare) {
            throw new Error("Mismatch between Paillier lambda and mu shares");
        }

        const sharePath = path.join(
            shareDir,
            `${name}-${KEY_ALGO_BOX}-share-${index + 1}.json`
        );

        writeJson(sharePath, {
            name,
            type: `${KEY_ALGO_BOX}-share`,
            index: index + 1,
            totalShares: SHARE_TOTAL,
            requiredShares: SHARE_THRESHOLD,
            lambdaShareB64: lambdaShare.toString("base64"),
            muShareB64: muShare.toString("base64"),
            createdAt: timestamp,
        });

        const relativeSharePath = path.relative(
            path.dirname(boxKeyPath),
            sharePath
        );

        return relativeSharePath.split(path.sep).join("/");
    });

    writeJson(boxKeyPath, {
        name,
        type: KEY_ALGO_BOX,
        createdAt: timestamp,
        publicKey: {
            n: publicKey.n.toString(),
            g: publicKey.g.toString(),
            bitLength: publicKey.bitLength,
        },
        threshold: {
            scheme: "shamir",
            totalShares: SHARE_TOTAL,
            requiredShares: SHARE_THRESHOLD,
            shareFiles,
        },
    });

    writeJson(signKeyPath, {
        name,
        type: KEY_ALGO_SIGN,
        publicKey: toBase64(signKeyPair.publicKey),
        secretKey: toBase64(signKeyPair.secretKey),
        createdAt: timestamp,
    });

    return {
        [KEY_ALGO_BOX]: boxKeyPath,
        [KEY_ALGO_SIGN]: signKeyPath,
    };
};

const encryptWithPublicKey = (plaintext, recipientPublicKeyFile) => {
    const keyPath = resolveKeyFile(recipientPublicKeyFile);
    const { publicKey } = readPaillierKeyMaterial(keyPath);

    const messageBigInt = utf8ToBigInt(plaintext);
    const ciphertextBigInt = publicKey.encrypt(messageBigInt);
    const nonce = randomBytes(32).toString("base64");

    return {
        ciphertextBase64: bigIntToBase64(ciphertextBigInt),
        nonceBase64: nonce,
    };
};

const decryptWithPrivateKey = (
    ciphertextBase64,
    _nonceBase64,
    recipientPrivateKeyFile,
    shareInputs
) => {
    const keyPath = resolveKeyFile(recipientPrivateKeyFile);
    const { keyData, publicKey } = readPaillierKeyMaterial(keyPath);
    const privateKey = reconstructPaillierPrivateKey(
        keyPath,
        keyData,
        publicKey,
        shareInputs
    );

    if (!privateKey) {
        throw new Error(
            "Paillier private key shares are required for homomorphic decryption"
        );
    }

    const ciphertextBigInt = base64ToBigInt(ciphertextBase64);
    const plaintextBigInt = privateKey.decrypt(ciphertextBigInt);

    return bigIntToUtf8(plaintextBigInt);
};

const signMessage = (privateSignKeyFile, message) => {
    const keyPath = resolveKeyFile(privateSignKeyFile);
    const { secretKey } = readJson(keyPath);

    if (!secretKey) {
        throw new Error("Signing secret key not found in key file");
    }

    const secretKeyUint8 = asUint8(fromBase64(secretKey));
    const messageUint8 = naclUtil.decodeUTF8(message);
    const signature = nacl.sign.detached(messageUint8, secretKeyUint8);

    return toBase64(signature);
};

const verifySignature = (publicSignKeyFile, message, signatureBase64) => {
    const keyPath = resolveKeyFile(publicSignKeyFile);
    const { publicKey } = readJson(keyPath);

    if (!publicKey) {
        throw new Error("Signing public key not found in key file");
    }

    const publicKeyUint8 = asUint8(fromBase64(publicKey));
    const messageUint8 = naclUtil.decodeUTF8(message);
    const signatureUint8 = asUint8(fromBase64(signatureBase64));

    return nacl.sign.detached.verify(
        messageUint8,
        signatureUint8,
        publicKeyUint8
    );
};

const computeCommitment = (ciphertextBase64, nonceBase64) => {
    const hash = createHash("sha256");
    hash.update(ciphertextBase64);
    hash.update(nonceBase64);
    return hash.digest("hex");
};

module.exports = {
    genKeypair,
    encryptWithPublicKey,
    decryptWithPrivateKey,
    signMessage,
    verifySignature,
    computeCommitment,
    constants: {
        KEY_ALGO_BOX,
        KEY_ALGO_SIGN,
        keysRoot,
        KEYS_DIR,
        SHARE_TOTAL,
        SHARE_THRESHOLD,
        SHARE_SUBDIR,
    },
};
