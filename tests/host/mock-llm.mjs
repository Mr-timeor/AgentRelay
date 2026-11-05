// 本地 OpenAI-compatible mock：只验证协议与工具闭环，不连接真实模型、不产生费用。
import http from "node:http";
import { appendFile } from "node:fs/promises";

const textOf = content => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(x => x?.type === "text").map(x => x.text).join("") : "";

const parseJson = text => {
  try { return JSON.parse(text); } catch { return undefined; }
};

const callsOf = messages => messages.flatMap(m =>
  m.role === "assistant" && Array.isArray(m.tool_calls)
    ? m.tool_calls.map(c => ({ name: c?.function?.name, args: parseJson(c?.function?.arguments) ?? {} })).filter(c => c.name)
    : []);

const toolCall = messages => callsOf(messages).at(-1);
const countCalls = (messages, name) => callsOf(messages).filter(c => c.name === name).length;

function pendingMarker(messages, marker) {
  for (let i = messages.length - 1; i >= 0 && messages[i].role === "user"; i--) {
    if (textOf(messages[i].content).split("\n").some(line => line.trim() === marker)) return true;
  }
  return false;
}

// Lead的当前工具结果后可能插入宿主通知；只跳过末尾通知，不跨过结束语或新指令。
function loopDecisionMessages(messages) {
  if (messages.some(message => textOf(message.content).includes("你是专项执行者"))) return messages;
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "user") {
    const text = textOf(messages[end - 1].content).trim();
    if (!/^Background subagent \S+ finished and will do no further work unless you send it more\./.test(text)
      && !/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text)) break;
    end--;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

export const reworkFeedback = "请补齐实现交付说明，再提交复核。";

export function decide(messages, { status = false, rework = false } = {}) {
  messages = loopDecisionMessages(messages);
  const allText = messages.map(m => textOf(m.content)).join("\n");
  const teammate = allText.includes("你是专项执行者");
  const calls = callsOf(messages);
  const last = messages.at(-1);
  if (!teammate) {
    if (rework && pendingMarker(messages, "SCHEDULER_REWORK_A2")) return { tool: "scheduler_manage", args: {
      action: "rework", target: "A2", feedback: reworkFeedback
    } };
    if (rework && pendingMarker(messages, "SCHEDULER_ACCEPT_A2")) return { tool: "scheduler_manage", args: { action: "accept", target: "A2" } };
    if (rework && pendingMarker(messages, "SCHEDULER_REWORK_READ_A2")) return { tool: "scheduler_status", args: { taskId: "A2" } };
    if (status && pendingMarker(messages, "SCHEDULER_STATUS_READ_A2")) return { tool: "scheduler_status", args: {} };
    const lastCall = toolCall(messages);
    if (rework && last?.role === "tool" && lastCall?.name === "scheduler_manage" && lastCall.args.action === "rework") {
      const returned = parseJson(textOf(last.content));
      if (lastCall.args.target === "A2" && Number.isInteger(returned?.revision) && returned.revision >= 0) {
        return { tool: "scheduler_manage", args: { action: "dispatch", target: "developer" } };
      }
      return { text: "没有成功退回的工具结果，停止探针续步。" };
    }
    if (rework && last?.role === "tool" && lastCall?.name === "scheduler_status" && lastCall.args.taskId === "A2") {
      return { text: "已读取A2返工记录。" };
    }
    if (status && last?.role === "tool" && lastCall?.name === "scheduler_status") {
      const result = parseJson(textOf(last.content));
      if (!lastCall.args.taskId && result?.tasks?.A2?.summaryRead) return { tool: "scheduler_status", args: result.tasks.A2.summaryRead };
      return { text: lastCall.args.taskId ? "已读取指定任务原文。" : "没有可读取的摘要入口。" };
    }
    if (last?.role === "user") {
      if (!calls.some(c => c.name === "scheduler_manage" && c.args?.action === "spawn")) {
        return { tool: "scheduler_manage", args: { action: "spawn", target: "developer" } };
      }
      return { text: "等待专项成员提交。" };
    }
    if (last?.role === "tool") {
      const call = toolCall(messages);
      if (call?.name === "scheduler_manage" && call.args?.action === "spawn") {
        if (!calls.some(c => c.name === "scheduler_manage" && c.args?.action === "dispatch")) {
          return { tool: "scheduler_manage", args: { action: "dispatch", target: "developer" } };
        }
      }
      return { text: "已派发，等待专项成员提交。" };
    }
    return { text: "mock: 无匹配脚本，结束。" };
  }
  if (last?.role === "user") {
    if (rework) return { tool: "scheduler_next", args: {} };
    if (calls.length === 0) return { tool: "scheduler_next", args: {} };
    const match = textOf(last.content).match(/Team message from lead:\s*(\{[\s\S]*\})/);
    if (match) {
      const delivery = parseJson(match[1]);
      if (delivery?.dispatchId) return { tool: "scheduler_next", args: { dispatchId: delivery.dispatchId } };
    }
    return { text: "等待 Lead 派发。" };
  }
  if (last?.role === "tool") {
    const result = parseJson(textOf(last.content)) ?? {};
    const call = toolCall(messages);
    if (call?.name === "scheduler_next") {
      if (result.waiting) return { text: "等待 Lead 派发。" };
      if (result.taskId) return {
        tool: "scheduler_report",
        args: {
          dispatchId: result.dispatchId, summary: status && result.taskId === "A2" ? "🐱".repeat(1200) + "A2 完成" : `${result.taskId} 完成`,
          ...(result.taskId === "A1" ? { outputs: '{"api":"docs/api.md"}' } : {}),
          ...(rework && result.taskId === "A2" ? { outputs: JSON.stringify({ implementation:
            result.rework ? "src/implementation-v2.mjs" : "src/implementation-v1.mjs" }) } : {})
        }
      };
    }
    if (call?.name === "scheduler_report") {
      if (rework && result.taskId === "A2") return { text: "A2交付结束，等待Lead验收。" };
      if (countCalls(messages, "scheduler_report") >= 2) return { text: "本轮任务完成。" };
      return { tool: "scheduler_next", args: {} };
    }
  }
  return { text: "mock: 无匹配脚本，结束。" };
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }]
  };
}

export function decideWake(messages, { addTasks = false, updateTask = false } = {}) {
  if (!messages.some(message => textOf(message.content).includes("你是专项执行者"))) {
    // 宿主可能把system-reminder作为后续user消息追加；只看当前末尾user组，不扫描历史重放。
    if (addTasks && pendingMarker(messages, "SCHEDULER_ADD_Q3")) {
      return { tool: "scheduler_manage", args: {
        action: "add-tasks", tasks: JSON.stringify({ id: "Q3", owner: "tester", dependsOn: ["Q2"] })
      } };
    }
    if (updateTask && pendingMarker(messages, "SCHEDULER_UPDATE_Q4")) {
      return { tool: "scheduler_manage", args: {
        action: "update-task", target: "Q4", changes: JSON.stringify({
          title: "已调整的待执行测试任务", owner: "tester", dependsOn: ["A2"]
        })
      } };
    }
    return { text: "已收到成员通知；常规派发由插件处理，本回合不调用调度工具。" };
  }
  const last = messages.at(-1), call = toolCall(messages);
  if (last?.role === "user") return { tool: "scheduler_next", args: {} };
  if (last?.role === "tool") {
    const result = parseJson(textOf(last.content)) ?? {};
    if (call?.name === "scheduler_next") {
      if (result.waiting) return { text: "等待下一条委托，结束本回合。" };
      if (result.taskId) return { tool: "scheduler_report", args: {
        dispatchId: result.dispatchId, summary: `${result.taskId} mock完成`,
        ...(result.taskId === "A1" ? { outputs: '{"api":"mock-api.md"}' } : {})
      } };
    }
    if (call?.name === "scheduler_report") return { tool: "scheduler_next", args: {} };
  }
  return { text: "mock: 无匹配脚本，结束。" };
}

export async function startMockLlm(logFile, { wake = false } = {}) {
  let sequence = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    let request;
    try { request = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const action = wake ? decideWake(request.messages ?? [], {
      addTasks: process.env.SCHEDULER_ADD_TASKS_TEST === "1", updateTask: process.env.SCHEDULER_UPDATE_TASK_TEST === "1"
    })
      : decide(request.messages ?? [], { status: process.env.SCHEDULER_STATUS_TEST === "1", rework: process.env.SCHEDULER_REWORK_TEST === "1" });
    if (logFile) {
      const messages = request.messages ?? [];
      const decisionMessages = wake ? messages : loopDecisionMessages(messages);
      const contextResult = (process.env.SCHEDULER_CONTEXT_TEST === "1" || process.env.SCHEDULER_REWORK_TEST === "1")
        && decisionMessages.at(-1)?.role === "tool" && toolCall(decisionMessages)?.name === "scheduler_next"
        ? parseJson(textOf(decisionMessages.at(-1).content)) : undefined;
      const statusResult = (process.env.SCHEDULER_STATUS_TEST === "1" || process.env.SCHEDULER_REWORK_TEST === "1")
        && decisionMessages.at(-1)?.role === "tool" && toolCall(decisionMessages)?.name === "scheduler_status"
        ? parseJson(textOf(decisionMessages.at(-1).content)) : undefined;
      await appendFile(logFile, JSON.stringify({
        at: new Date().toISOString(), action,
        ...(wake ? { actor: messages.some(m => textOf(m.content).includes("你是专项执行者")) ? "teammate" : "lead" } : {}),
        lastRole: messages.at(-1)?.role,
        count: messages.length,
        firstUser: textOf(messages.find(m => m.role === "user")?.content).slice(0, 200),
        last: textOf(messages.at(-1)?.content).slice(0, 300),
        ...(decisionMessages.length !== messages.length ? { ignoredHostNotices: messages.length - decisionMessages.length } : {}),
        ...(contextResult?.taskId ? { schedulerResult: contextResult } : {}),
        ...(statusResult ? { statusResult } : {})
      }) + "\n").catch(() => {});
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send(chunk({ role: "assistant" }));
    if (action.tool) {
      const id = `call_mock_${++sequence}`;
      send(chunk({
        tool_calls: [{
          index: 0, id, type: "function",
          function: { name: action.tool, arguments: JSON.stringify(action.args) }
        }]
      }));
      send(chunk({}, "tool_calls"));
    } else {
      send(chunk({ content: action.text ?? "" }));
      send(chunk({}, "stop"));
    }
    send({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
