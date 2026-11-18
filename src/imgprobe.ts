// 极简 BMP 读取 + "墨迹量" 统计，用于发送回执校验。
//
// 为什么要自己读 BMP：项目零依赖，没有 PNG/JPEG 解码器；而 BMP（24bpp 未压缩）的
// 像素是裸数据，解析只需要几十行。tools/ui-probe.ps1 用 System.Drawing 存 BMP。
//
// "墨迹量"(ink) = 与背景中位数差异超过阈值的像素数，近似等于"这块区域里有多少文字"。
// 发送成功后 QQ 会清空输入框 → ink 从几百掉到接近 0；点击落空则 ink 基本不变。

export function readBmp(buf) {
    if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error("not a BMP");
    const dataOffset = buf.readUInt32LE(10);
    const width = buf.readInt32LE(18);
    const rawHeight = buf.readInt32LE(22);
    const bpp = buf.readUInt16LE(28);
    if (bpp !== 24) throw new Error(`unsupported bmp bpp=${bpp}`);
    if (width <= 0 || rawHeight === 0) throw new Error("bad bmp size");

    const height = Math.abs(rawHeight);
    const bottomUp = rawHeight > 0;
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    if (dataOffset + rowSize * height > buf.length) throw new Error("truncated bmp");

    const gray = new Uint8Array(width * height);
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        const srcRow = bottomUp ? height - 1 - y : y;
        let p = dataOffset + srcRow * rowSize;
        let q = y * width * 3;
        for (let x = 0; x < width; x++) {
            const b = buf[p];
            const g = buf[p + 1];
            const r = buf[p + 2];
            // 亮度（BT.601），足够区分文字与背景
            gray[y * width + x] = (r * 299 + g * 587 + b * 114) / 1000;
            rgb[q] = r;
            rgb[q + 1] = g;
            rgb[q + 2] = b;
            q += 3;
            p += 3;
        }
    }
    return { width, height, gray, rgb };
}

// "蓝色占比" —— 用来判断 QQ 的蓝色「发送」按钮在不在。
// 这是判定「聊天面板是否真的打开了」的唯一稳定结构信号：
//   * 有会话打开 -> 右下角必有一个蓝色发送按钮（输入框为空时也是蓝的）
//   * 没有会话打开 -> 该区域是纯背景，蓝像素为 0
// 比"输入框里有没有字"稳，因为它不依赖文字是否粘贴成功。
export function blueRatio(img) {
    const rgb = img.rgb;
    if (!rgb) return 0;
    let n = 0;
    for (let i = 0; i < rgb.length; i += 3) {
        const r = rgb[i];
        const g = rgb[i + 1];
        const b = rgb[i + 2];
        if (b > r + 40 && b > 90 && b > g + 10) n++;
    }
    return n / Math.max(1, rgb.length / 3);
}

// 背景中位数 + 墨迹量。阈值 30 是实测出来比较稳的值：
// 输入框背景接近纯白，文字与背景的亮度差远大于 30；光标/边框通常只贡献极小面积。
export function inkStats(img, threshold = 30) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < img.gray.length; i++) hist[img.gray[i]]++;
    let acc = 0;
    let median = 255;
    const half = img.gray.length / 2;
    for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= half) {
            median = v;
            break;
        }
    }
    let ink = 0;
    for (let i = 0; i < img.gray.length; i++) {
        if (Math.abs(img.gray[i] - median) > threshold) ink++;
    }
    return { median, ink, total: img.gray.length, ratio: ink / Math.max(1, img.gray.length) };
}

// 判断"发送后输入框是否变空"（三点比对）。
//   emptyInk: 点进输入框、粘贴前  -> 代表"空输入框"的墨迹基准（含边框/占位符/光标）
//   fullInk : 粘贴后、点发送前    -> 代表"有文字"的墨迹
//   afterInk: 点发送后
// 只看"发送前后差值"是不可靠的：边框和占位符是静态的，墨迹永远不会掉到 0。
// 所以拿 after 去比"离空态近还是离满态近"。
// 前提 fullInk 要比 emptyInk 明显高（MIN_DELTA），否则说明截图区域对文字不敏感，
// 调用方应当跳过校验而不是给出错误结论。
// 两张同尺寸截图之间的"变了多少像素"。
//
// 为什么不再用"墨迹量差值"：QQ 输入框的占位符是**垂直居中**的，而输入的文字是
// **顶部对齐**的 —— 同一块固定比例的条带，在小窗口里可能落在文字上，在大窗口里
// 可能落在占位符上，在别的尺寸下又可能落在两者之间的空白里。实测 960x640 的窗口
// 上，一条按底距标定好的带子两个状态都是 ink=0（文字在更上面一行）。
// 像素差分只关心"这两次截图之间哪里变了"，与文字落在哪一行无关。
//
// 返回 -1 表示尺寸不一致（不可比）。阈值 28 略高于静态抗锯齿抖动，低于文字笔画。
export function diffPixels(a, b, threshold = 28) {
    if (!a || !b || !a.gray || !b.gray) return -1;
    if (a.width !== b.width || a.height !== b.height) return -1;
    let n = 0;
    const ga = a.gray;
    const gb = b.gray;
    for (let i = 0; i < ga.length; i++) {
        if (Math.abs(ga[i] - gb[i]) > threshold) n++;
    }
    return n;
}

export const MIN_INK_DELTA = 60;

export function probeUsable(emptyInk, fullInk) {
    return fullInk - emptyInk >= MIN_INK_DELTA;
}

export function looksSent(emptyInk, fullInk, afterInk) {
    if (!probeUsable(emptyInk, fullInk)) return true; // 不可判定时按已发送处理，避免误报
    const span = fullInk - emptyInk;
    return afterInk <= emptyInk + span * 0.45;
}
