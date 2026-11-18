// SQLCipher 页解密：支持 1024 字节自定义头偏移与 raw key / KDF 两种模式
import crypto from "node:crypto";

const MAGIC = Buffer.from("SQLite format 3\0", "latin1");

export function deriveKey(buf, p) {
    let pass;
    if (p.passForm === "utf8") pass = Buffer.from(p.candidate, "utf8");
    else if (p.passForm === "hex") pass = Buffer.from(p.candidate, "hex");
    else if (p.passForm?.startsWith("hex16-")) {
        const k = Number(p.passForm.slice(6));
        pass = Buffer.from(p.candidate, "hex").subarray(k * 16, k * 16 + 16);
    } else pass = Buffer.from(p.candidate, "utf8");
    if (p.mode === "raw") return pass;
    const hexField = buf.toString("latin1", 47, 175);
    const hexBuf = Buffer.from(hexField, "hex");
    const salts = {
        hex64: hexBuf,
        ascii128: Buffer.from(hexField, "utf8"),
        hex16head: hexBuf.subarray(0, 16),
        hex16tail: hexBuf.subarray(48, 64),
        page2head: buf.subarray(1024, 1040)
    };
    const salt = salts[p.salt] || buf.subarray(p.base, p.base + 16);
    const [hash, iter] = p.mode.split("/");
    return crypto.pbkdf2Sync(pass, salt, Number(iter), p.family === "sm4" ? 16 : 32, hash);
}

export function decryptDb(buf, p) {
    const key = deriveKey(buf, p);
    const { ps, reserve, base } = p;
    const bits = p.bits === 128 ? 128 : 256;
    const cipher = p.cipher === "ecb" ? "ecb" : p.cipher === "ctr" ? "ctr" : "cbc";
    const algo = p.family === "sm4" ? `sm4-${cipher}` : `aes-${bits}-${cipher}`;
    const page0From = p.layout === "master" ? 16 : 0;
    const pages = Math.floor((buf.length - base) / ps);
    const out = Buffer.alloc(pages * ps);
    for (let i = 0; i < pages; i++) {
        const src = buf.subarray(base + i * ps, base + (i + 1) * ps);
        const dst = out.subarray(i * ps, (i + 1) * ps);
        const iv = src.subarray(ps - reserve, ps - reserve + 16);
        const from = i === 0 ? page0From : 0;
        const ct = src.subarray(from, ps - reserve);
        const d = cipher === "ecb" ? crypto.createDecipheriv(algo, key, null) : crypto.createDecipheriv(algo, key, iv);
        d.setAutoPadding(false);
        const pt = Buffer.concat([d.update(ct), d.final()]);
        if (i === 0 && p.layout === "master") {
            MAGIC.copy(dst, 0);
            pt.copy(dst, 16);
        } else {
            pt.copy(dst, 0);
        }
    }
    return out;
}