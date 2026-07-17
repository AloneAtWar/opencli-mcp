// browser-diagnostics.js — 通用失败诊断，不针对任何特定网站

/**
 * 诊断 collect 为什么返回 0 条结果
 */
export function diagnoseCollect(data, input) {
  const diagnosis = { issue: null, hint: null, suggestions: [] };

  if (!data || typeof data !== "object") {
    diagnosis.issue = "no_data";
    diagnosis.hint = "Eval returned non-object data. The page may have navigated or errored.";
    return diagnosis;
  }

  const { total_roots = 0, scanned = 0, count = 0, selector = "" } = data;

  if (total_roots === 0) {
    diagnosis.issue = "selector_no_match";
    diagnosis.hint = `Selector "${selector}" matched 0 elements.`;
    if (input?.discover) {
      diagnosis.suggestions.push("discover mode found no repeated patterns. Try browser_snapshot to inspect the DOM.");
    } else {
      diagnosis.suggestions.push("Use browser_collect with discover:true to find candidate selectors.");
      diagnosis.suggestions.push("Or use browser_snapshot to inspect the page structure.");
    }
  } else if (count === 0 && scanned > 0) {
    diagnosis.issue = "all_filtered";
    diagnosis.hint = `Found ${scanned} root elements, but all were filtered out by required_fields or exclude.`;
    if (input?.required_fields?.length) {
      diagnosis.suggestions.push(`Check that these fields have content: ${input.required_fields.join(", ")}`);
    }
    if (input?.exclude) {
      diagnosis.suggestions.push("Exclude filter removed all items. Try relaxing the filter.");
    }
    diagnosis.suggestions.push("Set fallback_text:true if field selectors return empty.");
  } else {
    diagnosis.issue = "unknown";
    diagnosis.hint = `Scanned ${scanned}, returned ${count}.`;
  }

  return diagnosis;
}

/**
 * 诊断 browser_get / browser_read 为什么返回 null
 */
export function diagnoseGetNull(data, input) {
  const diagnosis = { issue: null, hint: null, suggestions: [] };

  if (data === null || data === undefined) {
    diagnosis.issue = "element_not_found";
    diagnosis.hint = `Selector "${input?.selector || "(none)"}" matched 0 elements.`;
    diagnosis.suggestions.push("The element may be lazily loaded. Try scrolling down first.");
    diagnosis.suggestions.push("Use browser_snapshot to inspect the current page structure.");
  } else if (typeof data === "string" && data.trim() === "") {
    diagnosis.issue = "empty_content";
    diagnosis.hint = "Element exists but has no text content.";
    diagnosis.suggestions.push("Try property:'html' to check if content is in nested elements.");
  } else {
    diagnosis.issue = "unexpected_null";
    diagnosis.hint = `Got unexpected null/undefined for property "${input?.property || "text"}".`;
  }

  return diagnosis;
}

/**
 * 诊断 wait_any 为什么超时
 */
export function diagnoseWaitTimeout(lastState, conditions, timeoutMs) {
  const diagnosis = { issue: null, hint: null, page_state: {}, suggestions: [] };

  if (lastState) {
    diagnosis.page_state = {
      url: lastState.url || null,
      title: lastState.title || null,
      matched: lastState.matched || false,
    };
  }

  if (!lastState) {
    diagnosis.issue = "page_not_loaded";
    diagnosis.hint = `No page state captured after ${timeoutMs}ms. The page may still be loading.`;
    diagnosis.suggestions.push("Increase timeout_ms.");
    diagnosis.suggestions.push("The page may have redirected or errored. Check with browser_get(url).");
  } else if (lastState.url) {
    diagnosis.issue = "condition_not_met";
    diagnosis.hint = `Page is at "${lastState.title || lastState.url}" but none of the ${conditions.length} conditions matched.`;
    for (const cond of conditions) {
      if (cond.type === "selector") {
        diagnosis.suggestions.push(`Selector "${cond.value}" not found. Try browser_snapshot to verify.`);
      } else if (cond.type === "text") {
        diagnosis.suggestions.push(`Text "${cond.value.slice(0, 50)}" not found. It may be in a lazily-loaded section.`);
      } else if (cond.type === "url_contains") {
        diagnosis.suggestions.push(`URL does not contain "${cond.value}". Current: ${lastState.url?.slice(0, 80)}`);
      }
    }
  }

  return diagnosis;
}

/**
 * 诊断 fill_submit 为什么失败
 */
export function diagnoseFillSubmit(data, input) {
  const diagnosis = { issue: null, hint: null, suggestions: [] };

  if (!data) {
    diagnosis.issue = "no_response";
    diagnosis.hint = "fill_submit returned no data.";
    return diagnosis;
  }

  if (data.error === "target_not_found") {
    diagnosis.issue = "target_not_found";
    diagnosis.hint = `Selector "${input?.target}" matched no elements.`;
    diagnosis.suggestions.push("The input field may not be visible. Check with browser_snapshot.");
    diagnosis.suggestions.push("Try a different selector or use browser_find to locate the element.");
  } else if (data.error === "invalid_selector") {
    diagnosis.issue = "invalid_selector";
    diagnosis.hint = `"${input?.target}" is not a valid CSS selector.`;
    diagnosis.suggestions.push("Check the selector syntax. Use browser_snapshot to find the correct element.");
  } else if (data.form_submitted === false && data.submit_strategy === "event") {
    diagnosis.issue = "event_only_no_submit";
    diagnosis.hint = "submit_strategy=event dispatched keyboard events but did not submit a form. The site may require form.submit().";
    diagnosis.suggestions.push("Try submit_strategy:form or submit_strategy:both.");
  }

  return diagnosis;
}

/**
 * 诊断 open 为什么失败
 */
export function diagnoseOpen(error, url) {
  const diagnosis = { issue: null, hint: null, suggestions: [] };

  const msg = error?.message || "";

  if (/timed out/i.test(msg)) {
    diagnosis.issue = "navigation_timeout";
    diagnosis.hint = `Failed to open "${url}" within timeout.`;
    diagnosis.suggestions.push("Increase timeout_ms (current default is 15s).");
    diagnosis.suggestions.push("The page may be very heavy. Try opening with window:'background'.");
  } else if (/ERR_NAME_NOT_RESOLVED/i.test(msg) || /ENOTFOUND/i.test(msg)) {
    diagnosis.issue = "dns_error";
    diagnosis.hint = `Could not resolve hostname for "${url}".`;
    diagnosis.suggestions.push("Check the URL spelling.");
    diagnosis.suggestions.push("You may need a VPN or proxy to access this site.");
  } else {
    diagnosis.issue = "unknown_error";
    diagnosis.hint = msg || "Unknown error during navigation.";
  }

  return diagnosis;
}

/**
 * 附加诊断信息到结果对象
 */
export function attachDiagnosis(result, diagnosis) {
  if (!result || !diagnosis || !diagnosis.issue) return result;
  return {
    ...result,
    diagnosis: {
      issue: diagnosis.issue,
      hint: diagnosis.hint,
      suggestions: diagnosis.suggestions,
    },
  };
}
