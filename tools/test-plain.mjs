// 自检：markdown 拍平（src/plain.ts）。纯函数，不联网、不读写数据。
//   node tools/test-plain.mjs
// 用法：改完 plain.ts 跑一遍，确认该删的删了、不该动的没动、且幂等。
import { toPlain } from "../src/plain.ts";

const cases = [
    ["# 标题\n正文 **加粗** 结束", "标题\n正文 加粗 结束"],
    ["* 一\n* 二\n+ 三\n- 四", "· 一\n· 二\n· 三\n· 四"],
    ["---\n分段\n---", "分段"],
    ["3 * 4 * 5 = 60，2*3=6", "3 * 4 * 5 = 60，2*3=6"],
    ["**提示词：**\n四只猫", "提示词：\n四只猫"],
    ["看 `llm.ts` 里的代码", "看 llm.ts 里的代码"],
    ["```ts\nconst a = 1;\n```", "const a = 1;"],
    ["> 引用\n>> 两层", "引用\n两层"],
    ["[官网](https://a.b/c)", "官网（https://a.b/c）"],
    ["我的名字是 my_file_name，Python 的 __init__ 保留", "我的名字是 my_file_name，Python 的 __init__ 保留"]
];

let fail = 0;
for (const [input, want] of cases) {
    const got = toPlain(input);
    const twice = toPlain(got);
    const ok = got === want;
    const idem = twice === got;
    if (!ok || !idem) {
        fail++;
        console.log(`✗ ${JSON.stringify(input)}`);
        if (!ok) console.log(`   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`);
        if (!idem) console.log(`   非幂等，第二次 ${JSON.stringify(twice)}`);
    } else {
        console.log(`✓ ${JSON.stringify(got)}`);
    }
}

// 工具调用协议泄漏：整条应该被清空（engine 里会因此跳过发送，不会发一坨 XML）
const leak =
    '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n' +
    '<｜｜DSML｜｜ parameter name="query" string="true">测试</｜｜DSML｜｜ parameter>\n' +
    "</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
const leakOut = toPlain(leak);
if (leakOut !== "") {
    fail++;
    console.log(`✗ DSML 泄漏没清干净: ${JSON.stringify(leakOut)}`);
} else {
    console.log("✓ DSML 泄漏整条清空");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
