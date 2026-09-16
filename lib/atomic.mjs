import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sha256(contents) {
	return crypto.createHash("sha256").update(contents).digest("hex");
}

export async function readFileIfPresent(filePath) {
	try {
		return await fs.readFile(filePath);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

export async function atomicWrite(filePath, contents, mode = 0o644) {
	const parent = path.dirname(filePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const temporary = path.join(parent, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
	let handle;
	try {
		handle = await fs.open(temporary, "wx", mode);
		await handle.writeFile(contents);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.chmod(temporary, mode);
		await fs.rename(temporary, filePath);
		try {
			const directory = await fs.open(parent, "r");
			await directory.sync();
			await directory.close();
		} catch (error) {
			if (!new Set(["EINVAL", "EISDIR", "EPERM", "EBADF"]).has(error.code)) throw error;
		}
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

export function stableJson(value) {
	const normalize = (input) => {
		if (Array.isArray(input)) return input.map(normalize);
		if (input && typeof input === "object") {
			return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
		}
		return input;
	};
	return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
