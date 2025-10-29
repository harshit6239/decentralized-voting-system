const fs = require("fs");
const path = require("path");

const receiptJson = process.env.MOCK_RECEIPT_JSON || "{}";
let receipt;
try {
    receipt = JSON.parse(receiptJson);
} catch (error) {
    receipt = {};
}

const capturePath = process.env.AXIOS_MOCK_OUTFILE;

const axiosMock = {
    post: async (url, data, options) => {
        if (capturePath) {
            fs.mkdirSync(path.dirname(capturePath), { recursive: true });
            fs.writeFileSync(
                capturePath,
                `${JSON.stringify(
                    { url, data, options: { timeout: options?.timeout } },
                    null,
                    2
                )}\n`,
                "utf8"
            );
        }

        return { data: receipt };
    },
};

try {
    const resolvedAxios = require.resolve("axios");
    require.cache[resolvedAxios] = { exports: axiosMock };
} catch (error) {
    // If axios is not resolvable, ignore – CLI will fail separately.
}
