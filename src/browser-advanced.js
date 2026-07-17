import { performance } from "node:perf_hooks";
import { appendTab, browserArgs, buildActionArgs } from "./commands.js";
import {
  diagnoseCollect,
  diagnoseFillSubmit,
  diagnoseGetNull,
  diagnoseOpen,
  diagnoseWaitTimeout,
  attachDiagnosis,
} from "./browser-diagnostics.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remainingMs(deadline, fallback = 5_000) {
  return Math.max(1, Math.min(fallback, Math.round(deadline - performance.now())));
}

function unwrapEval(data) {
  if (data && typeof data === "object" && data.value && typeof data.value === "object") return data.value;
  return data;
}

// ─────────────────────────────────────────────
// fill_submit
// ─────────────────────────────────────────────

export async function executeFillSubmit(run, input, options = {}) {
  const timeoutMs = options.timeoutMs ?? input.timeout_ms ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  const session = input.session;
  const key = input.key ?? "Enter";
  const submitStrategy = input.submit_strategy ?? "form";

  if (typeof input.target === "string" && input.atomic !== false) {
    const expression = buildFillSubmitExpression({ ...input, key, submit_strategy: submitStrategy });
    const args = browserArgs(session, "eval", expression);
    appendTab(args, input.tab);
    const result = await run(args, { timeoutMs });
    const data = unwrapEval(result.data);
    if (!data?.ok) {
      const diagnosis = diagnoseFillSubmit(data, input);
      throw Object.assign(new Error(`fill_submit failed: ${data?.error || "unknown DOM error"}`), { diagnosis });
    }
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

  const fill = await run(buildActionArgs({ ...shared, action: "fill", value: input.value }), { timeoutMs: remainingMs(deadline, timeoutMs) });
  const focus = await run(buildActionArgs({ ...shared, action: "focus" }), { timeoutMs: remainingMs(deadline, timeoutMs) });
  const keys = await run(buildActionArgs({ session, action: "keys", key, tab: input.tab }), { timeoutMs: remainingMs(deadline, timeoutMs) });

  return { data: { filled: fill.data, focused: focus.data, submitted: keys.data, key, mode: "cli-fallback" } };
}

export function buildFillSubmitExpression(input) {
  const config = JSON.stringify({
    selector: input.target,
    value: input.value,
    key: input.key ?? "Enter",
    submitStrategy: input.submit_strategy ?? "form",
  });
  return `(()=>{const config=${config};let element;try{element=document.querySelector(config.selector);}catch{return {ok:false,error:'invalid_selector'};}if(!element)return {ok:false,error:'target_not_found'};const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLInputElement?HTMLInputElement.prototype:Object.getPrototypeOf(element);const descriptor=Object.getOwnPropertyDescriptor(prototype,'value');if(descriptor?.set)descriptor.set.call(element,config.value);else element.value=config.value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));element.focus();const init={key:config.key,code:config.key==='Enter'?'Enter':config.key,bubbles:true,cancelable:true};const proceed=element.dispatchEvent(new KeyboardEvent('keydown',init));element.dispatchEvent(new KeyboardEvent('keypress',init));element.dispatchEvent(new KeyboardEvent('keyup',init));let formSubmitted=false;const shouldSubmit=config.submitStrategy==='form'||config.submitStrategy==='both';if(shouldSubmit&&proceed&&element.form){element.form.requestSubmit();formSubmitted=true;}const focused=element===document.activeElement?'n/a-submit-handled':(document.activeElement?.tagName||'unknown');return {ok:true,filled:element.value===config.value,value:element.value,key:config.key,focused,events_dispatched:true,form_submitted:formSubmitted,submit_strategy:config.submitStrategy};})()`;
}

// ─────────────────────────────────────────────
// wait_any (with tier + timeout diagnosis)
// ─────────────────────────────────────────────

export function buildWaitAnyExpression(conditions) {
  const sorted = [...conditions].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
  const encoded = JSON.stringify(sorted.map((c) => ({ type: c.type, value: c.value, tier: c.tier ?? 0 })));
  return `(()=>{const conditions=${encoded};let bestTier=null;let best=null;for(let index=0;index<conditions.length;index+=1){const condition=conditions[index];let matched=false;try{if(condition.type==='url_contains')matched=location.href.includes(condition.value);else if(condition.type==='title_contains')matched=document.title.includes(condition.value);else if(condition.type==='selector')matched=Boolean(document.querySelector(condition.value));else if(condition.type==='text')matched=(document.body?.innerText||'').includes(condition.value);}catch{}if(matched){if(bestTier===null||condition.tier<bestTier){bestTier=condition.tier;best={matched:true,index,condition,url:location.href,title:document.title,winner_tier:condition.tier};}}}return best||{matched:false,url:location.href,title:document.title};})()`;
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
  error.diagnosis = diagnoseWaitTimeout(last, conditions, timeoutMs);
  throw error;
}

// ─────────────────────────────────────────────
// collect (with auto-discover + diagnostics)
// ─────────────────────────────────────────────

export function buildCollectExpression(input) {
  if (input.discover) return buildDiscoverExpression(input);

  const config = {
    selector: input.selector,
    fields: input.fields,
    requiredFields: input.required_fields ?? [],
    offset: input.offset ?? 0,
    limit: input.limit ?? 20,
    maxFieldChars: input.max_field_chars ?? 2_000,
    fallbackText: input.fallback_text ?? true,
    deduplicateBy: input.deduplicate_by,
    exclude: input.exclude ?? null,
  };
  const encoded = JSON.stringify(config);
  return `(()=>{const config=${encoded};const all=[...document.querySelectorAll(config.selector)];const roots=all.slice(config.offset,config.offset+config.limit);const read=(root,field)=>{let element=root;if(field.selector){try{element=root.matches(field.selector)?root:root.querySelector(field.selector);}catch{return null;}}if(!element)return null;let value=null;if(field.property==='href')value=element.href||element.getAttribute('href');else if(field.property==='src')value=element.src||element.getAttribute('src');else if(field.property==='value')value=element.value??element.getAttribute('value');else if(field.property==='html')value=element.innerHTML;else if(field.property==='attribute')value=element.getAttribute(field.attribute);else value=(element.innerText||element.textContent||'').trim();if((value===null||value==='')&&config.fallbackText&&field.property!=='href'&&field.property!=='src'&&field.property!=='html'){value=(root.innerText||root.textContent||'').trim();}if(typeof value==='string'&&value.length>config.maxFieldChars)value=value.slice(0,config.maxFieldChars);return value;};const matchesExclude=(item)=>{if(!config.exclude)return false;const ec=config.exclude;if(ec.title_contains&&item.title&&ec.title_contains.some(p=>item.title.includes(p)))return true;if(ec.href_contains&&item.href&&ec.href_contains.some(p=>item.href.includes(p)))return true;if(ec.text_contains&&ec.text_contains.some(p=>(item.title||'').includes(p)||(item.desc||'').includes(p)))return true;return false;};let items=roots.map((root,index)=>{const item={_index:config.offset+index};for(const field of config.fields)item[field.name]=read(root,field);return item;}).filter(item=>config.requiredFields.every(name=>item[name]!==null&&item[name]!==undefined&&String(item[name]).trim()!==''));if(matchesExclude)items=items.filter(item=>!matchesExclude(item));if(config.deduplicateBy){const seen=new Set();items=items.filter(item=>{const key=String(item[config.deduplicateBy]||'');if(seen.has(key))return false;seen.add(key);return true;});}return {selector:config.selector,scanned:roots.length,total_roots:all.length,offset:config.offset,limit:config.limit,count:items.length,deduplicated:config.deduplicateBy?true:false,items};})()`;
}

function buildDiscoverExpression(input) {
  const encoded = JSON.stringify({ probeSelectors: input.probe_selectors ?? [], limit: input.limit ?? 5 });
  return `(()=>{const config=${encoded};function probe(selector){try{const all=document.querySelectorAll(selector);if(all.length<2)return null;const tagCounts={};[...all].forEach(el=>{tagCounts[el.tagName]=(tagCounts[el.tagName]||0)+1;});const mostCommon=Object.entries(tagCounts).sort((a,b)=>b[1]-a[1])[0];const items=[...all].slice(0,3).map(el=>{const h3=el.querySelector('h3');const title=(h3||el).innerText.trim().slice(0,120);const href=el.querySelector('a')?.href||'';const firstSpan=el.querySelector('span')?.innerText?.trim().slice(0,200)||'';return {title,href,preview:firstSpan};});return {selector,matches:all.length,dominant_tag:mostCommon?.[0]||'unknown',items};}catch{return null;}}const probeSelectors=['section','article','li','[role=listitem]','[role=article]','.result','.c-container','.item','.card','.post','.feed-item','.search-result'];const customProbes=config.probeSelectors.filter(s=>typeof s==='string'&&s.length>0);const allProbes=[...customProbes,...probeSelectors.filter(s=>!customProbes.includes(s))];const candidates=[];for(const s of allProbes){const r=probe(s);if(r&&r.items.some(i=>i.title.length>2))candidates.push(r);if(candidates.length>=config.limit)break;}return {mode:'discover',probed:allProbes.length,candidates,tip:candidates.length===0?'No repeated patterns found. Try browser_snapshot to inspect the DOM structure.':'Use browser_collect with a candidate selector and field mappings based on the samples above.'};})()`;
}

export async function executeCollect(run, input, options = {}) {
  if (!input.discover && !input.selector) throw new Error("collect requires selector");
  if (!input.discover && (!Array.isArray(input.fields) || input.fields.length === 0)) throw new Error("collect requires at least one field");

  const timeoutMs = options.timeoutMs ?? input.timeout_ms ?? 10_000;
  const expression = buildCollectExpression(input);
  const args = browserArgs(input.session, "eval", expression);
  appendTab(args, input.tab);
  const result = await run(args, { timeoutMs });
  const data = unwrapEval(result.data);

  // 自动侦察：selector 匹配 0 个时自动 discover
  if (!input.discover && data && typeof data === "object" && data.total_roots === 0 && input.auto_discover !== false) {
    const discoverInput = { ...input, discover: true, fields: undefined, required_fields: undefined };
    const discoverExpr = buildDiscoverExpression(discoverInput);
    const discoverArgs = browserArgs(input.session, "eval", discoverExpr);
    appendTab(discoverArgs, input.tab);
    const discoverResult = await run(discoverArgs, { timeoutMs: Math.min(timeoutMs, 5_000) });
    const discoverData = unwrapEval(discoverResult.data);
    return {
      ...result,
      data: {
        ...data,
        diagnosis: diagnoseCollect(data, input),
        auto_discover: discoverData,
      },
    };
  }

  // 有结果但全部被过滤
  if (data && typeof data === "object" && data.total_roots > 0 && data.count === 0) {
    return {
      ...result,
      data: {
        ...data,
        diagnosis: diagnoseCollect(data, input),
      },
    };
  }

  return { ...result, data };
}

// ─────────────────────────────────────────────
// read — 内容提取（text/html/markdown），支持懒加载自动重试
// ─────────────────────────────────────────────

export async function executeRead(run, input, options = {}) {
  const timeoutMs = options.timeoutMs ?? input.timeout_ms ?? 10_000;
  const session = input.session;
  const selector = input.selector;
  const property = input.property ?? "text";
  const autoRetry = input.auto_scroll_retry !== false;

  const doRead = async (sel) => {
    const args = browserArgs(session, "get", property);
    if (sel) args.push(String(sel));
    appendTab(args, input.tab);
    const result = await run(args, { timeoutMs });
    return result;
  };

  let result = await doRead(selector);
  let data = result.data;

  // 检查是否为 null/空
  const isNull = data === null || data === undefined || data === "null";
  const isEmpty = typeof data === "string" && data.trim() === "" && property === "text";

  if ((isNull || isEmpty) && autoRetry && selector) {
    // 滚动触发懒加载
    const scrollArgs = browserArgs(session, "state", "--scroll", "down");
    appendTab(scrollArgs, input.tab);
    try {
      await run(scrollArgs, { timeoutMs: 3_000 });
    } catch {
      // 滚动失败不阻塞
    }

    // 等待元素出现
    const waitExpr = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
    const waitDeadline = performance.now() + Math.min(timeoutMs, 5_000);
    while (performance.now() < waitDeadline) {
      await sleep(300);
      const checkArgs = browserArgs(session, "eval", waitExpr);
      appendTab(checkArgs, input.tab);
      try {
        const checkResult = await run(checkArgs, { timeoutMs: 2_000 });
        const checkData = unwrapEval(checkResult.data);
        if (checkData === true) break;
      } catch {
        break;
      }
    }

    // 重试读取
    result = await doRead(selector);
    data = result.data;
  }

  // 诊断
  if (data === null || data === undefined || data === "null") {
    const diagnosis = diagnoseGetNull(data, input);
    return { ...result, data: { value: null, property, diagnosis } };
  }
  if (typeof data === "string" && data.trim() === "" && property === "text") {
    const diagnosis = diagnoseGetNull(data, input);
    return { ...result, data: { value: "", property, diagnosis } };
  }

  return { ...result, data: { value: data, property, chars: typeof data === "string" ? data.length : undefined } };
}

// ─────────────────────────────────────────────
// open — 带诊断
// ─────────────────────────────────────────────

export async function executeOpen(run, input, options = {}) {
  const timeoutMs = options.timeoutMs ?? input.timeout_ms ?? 15_000;
  const args = ["open", input.url];
  if (input.window) args.push("--window", input.window);
  appendTab(args, input.tab);
  try {
    return await run(args, { timeoutMs });
  } catch (error) {
    const diagnosis = diagnoseOpen(error, input.url);
    const wrapped = Object.assign(new Error(error.message), { details: error.details, diagnosis });
    throw wrapped;
  }
}
