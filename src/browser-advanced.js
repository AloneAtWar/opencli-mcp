import { performance } from "node:perf_hooks";
import { appendTab, browserArgs, buildActionArgs } from "./commands.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remainingMs(deadline, fallback = 5_000) {
  return Math.max(1, Math.min(fallback, Math.round(deadline - performance.now())));
}

export async function executeFillSubmit(run, input, options = {}) {
  const timeoutMs = options.timeoutMs ?? input.timeout_ms ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  const session = input.session;
  const key = input.key ?? "Enter";
  if (typeof input.target === "string" && input.atomic !== false) {
    const expression = buildFillSubmitExpression({ ...input, key });
    const args = browserArgs(session, "eval", expression);
    appendTab(args, input.tab);
    const result = await run(args, { timeoutMs });
    const data = unwrapEval(result.data);
    if (!data?.ok) throw new Error(`fill_submit failed: ${data?.error || "unknown DOM error"}`);
    return { ...result, data: { ...data, mode: "atomic-dom-event" } };
  }
  const shared = {
    session,
    target: input.target,
    role: input.role,
    name: input.name,
    label: input.label,
    text_locator: input.text_locator,
    testid: input.testid,
    nth: input.nth,
    tab: input.tab,
  };

  const fill = await run(
    buildActionArgs({ ...shared, action: "fill", value: input.value }),
    { timeoutMs: remainingMs(deadline, timeoutMs) },
  );
  const focus = await run(
    buildActionArgs({ ...shared, action: "focus" }),
    { timeoutMs: remainingMs(deadline, timeoutMs) },
  );
  const keys = await run(
    buildActionArgs({ session, action: "keys", key, tab: input.tab }),
    { timeoutMs: remainingMs(deadline, timeoutMs) },
  );

  return {
    data: {
      filled: fill.data,
      focused: focus.data,
      submitted: keys.data,
      key,
    },
  };
}

export function buildWaitAnyExpression(conditions) {
  const encoded = JSON.stringify(conditions);
  return `(()=>{const conditions=${encoded};for(let index=0;index<conditions.length;index+=1){const condition=conditions[index];let matched=false;try{if(condition.type==='url_contains')matched=location.href.includes(condition.value);else if(condition.type==='title_contains')matched=document.title.includes(condition.value);else if(condition.type==='selector')matched=Boolean(document.querySelector(condition.value));else if(condition.type==='text')matched=(document.body?.innerText||'').includes(condition.value);}catch{}if(matched)return {matched:true,index,condition,url:location.href,title:document.title};}return {matched:false,url:location.href,title:document.title};})()`;
}

function unwrapEval(data) {
  if (data && typeof data === "object" && data.value && typeof data.value === "object") return data.value;
  return data;
}

export function buildFillSubmitExpression(input) {
  const config = JSON.stringify({ selector: input.target, value: input.value, key: input.key ?? "Enter" });
  return `(()=>{const config=${config};let element;try{element=document.querySelector(config.selector);}catch{return {ok:false,error:'invalid_selector'};}if(!element)return {ok:false,error:'target_not_found'};const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLInputElement?HTMLInputElement.prototype:Object.getPrototypeOf(element);const descriptor=Object.getOwnPropertyDescriptor(prototype,'value');if(descriptor?.set)descriptor.set.call(element,config.value);else element.value=config.value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));element.focus();const init={key:config.key,code:config.key==='Enter'?'Enter':config.key,bubbles:true,cancelable:true};const proceed=element.dispatchEvent(new KeyboardEvent('keydown',init));element.dispatchEvent(new KeyboardEvent('keypress',init));element.dispatchEvent(new KeyboardEvent('keyup',init));let formSubmitted=false;if(config.key==='Enter'&&proceed&&element.form){element.form.requestSubmit();formSubmitted=true;}return {ok:true,filled:element.value===config.value,value:element.value,key:config.key,focused:document.activeElement===element,events_dispatched:true,form_submitted:formSubmitted};})()`;
}

export async function executeWaitAny(run, input, options = {}) {
  const conditions = input.conditions ?? input.any ?? [];
  if (conditions.length === 0) throw new Error("wait_any requires at least one condition");
  const timeoutMs = options.timeoutMs ?? input.timeout_ms ?? 10_000;
  const pollMs = input.poll_ms ?? 250;
  const deadline = performance.now() + timeoutMs;
  const expression = buildWaitAnyExpression(conditions);
  let last = null;
  let attempts = 0;

  while (performance.now() < deadline) {
    attempts += 1;
    const args = browserArgs(input.session, "eval", expression);
    appendTab(args, input.tab);
    try {
      const result = await run(args, { timeoutMs: remainingMs(deadline, 5_000) });
      last = unwrapEval(result.data);
      if (last?.matched) return { data: { ...last, attempts } };
    } catch (error) {
      const timedOut = error?.details?.code === "TIMEOUT" || /timed out/i.test(error?.message || "");
      if (!timedOut) throw error;
      if (performance.now() + 100 >= deadline) break;
      continue;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }

  const error = new Error(`wait_any timed out after ${timeoutMs}ms`);
  error.lastState = last;
  throw error;
}

export function buildCollectExpression(input) {
  const config = {
    selector: input.selector,
    fields: input.fields,
    requiredFields: input.required_fields ?? [],
    offset: input.offset ?? 0,
    limit: input.limit ?? 20,
    maxFieldChars: input.max_field_chars ?? 2_000,
  };
  const encoded = JSON.stringify(config);
  return `(()=>{const config=${encoded};const all=[...document.querySelectorAll(config.selector)];const roots=all.slice(config.offset,config.offset+config.limit);const read=(root,field)=>{let element=root;if(field.selector){try{element=root.matches(field.selector)?root:root.querySelector(field.selector);}catch{return null;}}if(!element)return null;let value=null;if(field.property==='href')value=element.href||element.getAttribute('href');else if(field.property==='src')value=element.src||element.getAttribute('src');else if(field.property==='value')value=element.value??element.getAttribute('value');else if(field.property==='html')value=element.innerHTML;else if(field.property==='attribute')value=element.getAttribute(field.attribute);else value=(element.innerText||element.textContent||'').trim();if(typeof value==='string'&&value.length>config.maxFieldChars)value=value.slice(0,config.maxFieldChars);return value;};const items=roots.map((root,index)=>{const item={_index:config.offset+index};for(const field of config.fields)item[field.name]=read(root,field);return item;}).filter(item=>config.requiredFields.every(name=>item[name]!==null&&item[name]!==undefined&&String(item[name]).trim()!==''));return {selector:config.selector,scanned:roots.length,total_roots:all.length,offset:config.offset,limit:config.limit,count:items.length,items};})()`;
}

export async function executeCollect(run, input, options = {}) {
  if (!input.selector) throw new Error("collect requires selector");
  if (!Array.isArray(input.fields) || input.fields.length === 0) throw new Error("collect requires at least one field");
  const expression = buildCollectExpression(input);
  const args = browserArgs(input.session, "eval", expression);
  appendTab(args, input.tab);
  const result = await run(args, { timeoutMs: options.timeoutMs ?? input.timeout_ms ?? 10_000 });
  return { ...result, data: unwrapEval(result.data) };
}
