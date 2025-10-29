const fs = require("fs");
const path = require("path");

const ensureDir = (targetPath) => {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
};

const readJson = (filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
};

const writeJson = (filePath, data) => {
    ensureDir(filePath);
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    fs.writeFileSync(filePath, serialized, "utf8");
};

const nowISO = () => new Date().toISOString();

const toBase64 = (input) => {
    if (input instanceof Uint8Array) {
        return Buffer.from(input).toString("base64");
    }

    if (Buffer.isBuffer(input)) {
        return input.toString("base64");
    }

    if (typeof input === "string") {
        return Buffer.from(input, "utf8").toString("base64");
    }

    throw new TypeError("Unsupported type for base64 conversion");
};

const fromBase64 = (input) => Buffer.from(input, "base64");

module.exports = {
    ensureDir,
    readJson,
    writeJson,
    nowISO,
    toBase64,
    fromBase64,
};
