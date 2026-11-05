// 启动探针专用的本地 OpenAI 兼容 mock。
import http from "node:http";
import { appendFile } from "node:fs/promises";

const textOf = content => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(item => item?.type === "text").map(item => item.text).join("") : "";

function parseJson(value) {
  try { return JSON.parse(value); } catch { return undefined; }
}

function actorOf(messages) {
  for (const message of messages) {
    const actor = textOf(message.content).match(/你是专项执行者(tester|developer)(?=[。\s])/u)?.[1];
    if (actor) return actor;
  }
  return "lead";
}

function decisionMessages(messages) {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "user") {
    const text = textOf(messages[end - 1].content).trim();
    if (!/^Background subagent \S+ finished and will do no further work unless you send it more\./u.test(text)
      && !/^<system-reminder>[\s\S]*<\/system-reminder>$/u.test(text)) break;
    end--;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

function toolCalls(messages) {
  return messages.flatMap(message => message.role === "assistant" && Array.isArray(message.tool_calls)
    ? message.tool_calls.map(call => ({ id: call.id, name: call.function?.name,
      args: parseJson(call.function?.arguments) ?? {} })) : []);
}

function currentTool(messages) {
  const last = messages.at(-1);
  if (last?.role !== "tool") return undefined;
  const calls = toolCalls(messages);
  const call = last.tool_call_id ? calls.findLast(item => item.id === last.tool_call_id) : calls.at(-1);
  const parsed = parseJson(textOf(last.content));
  const result = typeof parsed?.result === "string" ? parseJson(parsed.result) : parsed;
  return { call, result };
}

function currentDelivery(messages) {
  for (let i = messages.length - 1; i >= 0 && messages[i].role === "user"; i--) {
    const text = textOf(messages[i].content).trim();
    const body = text.match(/Team message from lead:\s*(\{[\s\S]*\})/u)?.[1] ?? text;
    const value = parseJson(body);
    if (typeof value?.taskId === "string" && typeof value.dispatchId === "string") return value;
  }
  return undefined;
}

export function decideStartup(messages) {
  const actor = actorOf(messages);
  if (actor === "lead") return { text: "收到成员通知，常规推进由插件完成。" };
  const current = decisionMessages(messages);
  const last = current.at(-1);
  if (last?.role === "user") {
    const delivery = currentDelivery(current);
    if (delivery) return { tool: "scheduler_next", args: { dispatchId: delivery.dispatchId } };
    const alreadyReady = toolCalls(current).some(call => call.name === "scheduler_next"
      && typeof call.args.readySummary === "string" && call.args.readySummary.trim());
    if (!alreadyReady) return { tool: "scheduler_next", args: { readySummary: `${actor}分工已就绪` } };
    return { text: "等待下一条正式委托，结束本回合。" };
  }
  const operation = currentTool(current);
  if (operation?.call?.name === "scheduler_next") {
    if (operation.result?.waiting) return { text: "已回复准备情况，等待正式委托。" };
    if (typeof operation.result?.taskId === "string" && typeof operation.result.dispatchId === "string") {
      return { tool: "scheduler_report", args: {
        dispatchId: operation.result.dispatchId, summary: `${actor}已完成${operation.result.taskId}`,
        ...(operation.result.taskId === "A1" ? { outputs: JSON.stringify({ api: "mock-api.md" }) } : {})
      } };
    }
  }
  if (operation?.call?.name === "scheduler_report" && typeof operation.result?.taskId === "string"
    && operation.result.state?.status === "completed") return { tool: "scheduler_next", args: {} };
  return { text: "本轮没有可继续的成功工具结果，结束。" };
}

function chunk(delta, finish = null) {
  return { id: "chatcmpl-startup-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }] };
}

export async function startStartupMock(logFile) {
  let sequence = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const part of req) body += part;
      const request = parseJson(body);
      if (!request || !Array.isArray(request.messages)) { res.writeHead(400).end(); return; }
      const messages = request.messages;
      const current = decisionMessages(messages);
      const operation = currentTool(current);
      const action = decideStartup(messages);
      if (logFile) await appendFile(logFile, JSON.stringify({
        at: new Date().toISOString(), actor: actorOf(messages), action,
        lastRole: messages.at(-1)?.role, decisionLastRole: current.at(-1)?.role,
        count: messages.length, ignoredHostNotices: messages.length - current.length,
        firstUser: textOf(messages.find(message => message.role === "user")?.content).slice(0, 1000),
        lastUser: textOf(messages.findLast(message => message.role === "user")?.content).slice(0, 1000),
        ...(operation ? { toolName: operation.call?.name, toolResult: operation.result } : {})
      }) + "\n");
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache", connection: "keep-alive" });
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send(chunk({ role: "assistant" }));
      if (action.tool) {
        send(chunk({ tool_calls: [{ index: 0, id: `call_startup_${++sequence}`, type: "function",
          function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }));
        send(chunk({}, "tool_calls"));
      } else {
        send(chunk({ content: action.text ?? "" }));
        send(chunk({}, "stop"));
      }
      send({ id: "chatcmpl-startup-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
        model: "mock-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error?.message ?? error));
      else res.destroy(error);
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
