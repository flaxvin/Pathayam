/**
 * The entire client-side script, served as one static asset.
 *
 * R35 governs everything here: **no user data touches the device**. There is
 * no localStorage, no sessionStorage, no IndexedDB, no Cache API, and no
 * service worker. State lives in module scope and dies with the tab, which is
 * resilience, not persistence (`08` §3.3).
 *
 * What it does provide is R36's retry contract — the reason the server-only
 * policy is survivable on a phone with two bars.
 */

export const CLIENT_SCRIPT = String.raw`
(function () {
  "use strict";

  // --- R36.1: a stable key per logical operation, regenerated only on success.
  function newKey() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "k-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  // ---------------------------------------------------------------------------
  // R36.5-R36.7 · Submit with bounded retry
  //
  // The user must see one of exactly three outcomes and never ambiguity:
  // saved, still trying, or failed with what they typed still on screen.
  // ---------------------------------------------------------------------------
  var RETRY_DELAYS = [1000, 3000, 7000, 9000]; // ~20s total, per 08 J21

  function setStatus(form, text, kind) {
    var el = form.querySelector("[data-status]");
    if (!el) {
      el = document.createElement("p");
      el.setAttribute("data-status", "");
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      form.appendChild(el);
    }
    el.textContent = text || "";
    el.className = kind ? "notice notice-" + kind : "faint";
    el.hidden = !text;
  }

  // ---------------------------------------------------------------------------
  // In-place page update
  //
  // Every mutation used to end in location.href or location.reload(), which
  // threw away the scroll position: nudge a category at the bottom of a long
  // Categories page and you were bounced to the top to find it. It also lost
  // the success message, because the redirect branch returned before the
  // status was ever shown.
  //
  // So instead of navigating, fetch the target, swap the contents of main, and
  // leave the viewport where it was. R35 is untouched — nothing is stored on
  // the device; this is one more request, not a cache.
  // ---------------------------------------------------------------------------

  function resolve(url) {
    var a = document.createElement("a");
    a.href = url;
    return a;
  }

  // Scroll follows the *path*, not the whole URL. Assigning on the budget grid
  // redirects to "/?month=2026-09" from "/", and a stricter comparison read
  // that as a page change and threw the user back to the top of the grid — the
  // exact thing this is here to prevent. A different path is a real navigation
  // and does belong at the top.
  function samePage(url) {
    return resolve(url).pathname === window.location.pathname;
  }

  // Capture enough to put the user back where they were typing. The value is
  // carried across only for the element that still has focus: if the swap
  // lands while they are part-way through the next amount, their keystrokes
  // must survive it.
  function rememberFocus() {
    var el = document.activeElement;
    var main = document.getElementById("main");
    if (!el || !el.id || !main || !main.contains(el)) return null;
    var editable = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    return {
      id: el.id,
      value: editable ? el.value : null,
      start: editable && el.selectionStart !== undefined ? el.selectionStart : null,
      end: editable && el.selectionEnd !== undefined ? el.selectionEnd : null,
    };
  }

  function restoreFocus(memo) {
    if (!memo) return;
    var el = document.getElementById(memo.id);
    if (!el) return;
    if (memo.value !== null && el.value !== undefined) el.value = memo.value;
    try {
      el.focus({ preventScroll: true });
      if (memo.start !== null && el.setSelectionRange) el.setSelectionRange(memo.start, memo.end);
    } catch (e) {
      // A hidden or disabled control cannot take focus. Nothing to do.
    }
  }

  /*
   * B80 · Carry the open/closed state of every disclosure across a swap.
   *
   * Groups on the budget screen are details elements, and the budget is seven
   * screens on a phone, so collapsing the ones you are not working on is how
   * the screen becomes usable. Replacing the markup threw that away: collapse
   * two groups, assign a rupee, and everything sprang open again. A full page
   * navigation did the same, but nobody noticed then because the page also
   * jumped to the top — fixing the jump is what made this visible.
   *
   * Keyed on the summary's text rather than an id, because that is what the
   * household actually recognises, and it survives a group being reordered or
   * re-rendered. R35 is untouched: this lives for the length of one swap and is
   * never written anywhere.
   */
  function disclosureState(root) {
    var state = {};
    root.querySelectorAll("details").forEach(function (el) {
      var summary = el.querySelector("summary");
      var key = el.id || (summary ? summary.textContent.trim() : "");
      if (key) state[key] = el.open;
    });
    return state;
  }

  function restoreDisclosures(root, state) {
    if (!state) return;
    root.querySelectorAll("details").forEach(function (el) {
      var summary = el.querySelector("summary");
      var key = el.id || (summary ? summary.textContent.trim() : "");
      if (key && Object.prototype.hasOwnProperty.call(state, key)) el.open = state[key];
    });
  }

  function initialiseContent(root) {
    root.querySelectorAll('input[name="return_to"]').forEach(function (input) {
      if (!input.value) input.value = window.location.pathname + window.location.search;
    });
    root.querySelectorAll("[data-reveal]").forEach(applyReveal);
  }

  function showPageNotice(message, kind) {
    var main = document.getElementById("main");
    if (!main || !message) return;
    var el = document.createElement("div");
    el.className = "notice notice-" + (kind || "success");
    el.setAttribute("role", "status");
    el.textContent = message;
    main.insertBefore(el, main.firstChild);
  }

  function updatePage(url, message, kind, onFail) {
    var stayPut = samePage(url);
    var link = resolve(url);
    var sameUrl = stayPut && link.search === window.location.search;
    var x = window.scrollX;
    var y = window.scrollY;

    fetch(url, { headers: { Accept: "text/html" }, credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("not ok");
        return response.text();
      })
      .then(function (markup) {
        var doc = new DOMParser().parseFromString(markup, "text/html");
        var fresh = doc.getElementById("main");
        var current = document.getElementById("main");
        if (!fresh || !current) throw new Error("no main");

        /*
         * The sign-in, first-run and error screens render bare — no header, no
         * sidebar, no bottom nav — so their DOM has nothing to swap chrome
         * into. Swapping only the main element would drop the budget grid into the
         * bare shell and leave the page with no navigation at all, which is
         * exactly what entering the demo used to do: the form posts from
         * /signin, and everything after it arrived chrome-less.
         *
         * Shells differing means a real navigation, not a swap.
         */
        var hadChrome = Boolean(document.querySelector(".with-sidebar"));
        var wantsChrome = Boolean(doc.querySelector(".with-sidebar"));
        if (hadChrome !== wantsChrome) {
          window.location.href = url;
          return;
        }

        var memo = stayPut ? rememberFocus() : null;
        var disclosures = stayPut ? disclosureState(current) : null;
        current.innerHTML = fresh.innerHTML;
        restoreDisclosures(current, disclosures);

        // The navigation chrome carries the current-page marker and the review
        // badge, so it has to move with the content.
        [".sidebar", ".bottom-nav"].forEach(function (selector) {
          var freshNav = doc.querySelector(selector);
          var currentNav = document.querySelector(selector);
          if (freshNav && currentNav) currentNav.innerHTML = freshNav.innerHTML;
        });

        if (doc.title) document.title = doc.title;
        // Keep the address bar truthful even when the scroll is held: a month
        // change has to survive a refresh or a bookmark.
        if (!sameUrl && window.history && window.history.replaceState) {
          if (stayPut) window.history.replaceState({}, "", url);
          else if (window.history.pushState) window.history.pushState({}, "", url);
        }

        initialiseContent(current);
        showPageNotice(message, kind);

        if (stayPut) {
          window.scrollTo(x, y);
          restoreFocus(memo);
        } else {
          window.scrollTo(0, 0);
        }
      })
      .catch(function () {
        // If anything about the swap fails, fall back to the plain navigation
        // rather than leaving a stale page on screen (R35.3).
        if (onFail) onFail();
        window.location.href = url;
      });
  }

  // The swapped-in URL is a real history entry, so Back has to fetch it again.
  window.addEventListener("popstate", function () {
    window.location.reload();
  });

  function submitWithRetry(form) {
    var submitButton = form.querySelector('button[type="submit"], button:not([type])');
    var originalLabel = submitButton ? submitButton.textContent : null;
    var key = form.dataset.idempotencyKey || newKey();
    form.dataset.idempotencyKey = key;

    var attempt = 0;

    function finish(message, kind) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
      setStatus(form, message, kind);
    }

    function tryOnce() {
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Saving…";
      }
      setStatus(form, attempt === 0 ? "Saving…" : "Still trying…", null);

      var body = new URLSearchParams(new FormData(form));

      fetch(form.action, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": key,
          "Accept": "application/json",
        },
        body: body,
        credentials: "same-origin",
      })
        .then(function (response) {
          // R36.6: retry only on 5xx, 408 and 429. A 4xx is the server telling
          // us something real, and repeating it will not help.
          if (response.status >= 500 || response.status === 408 || response.status === 429) {
            throw new Error("retryable");
          }
          if (response.status === 409) {
            // The first attempt is still in flight. Wait and ask again rather
            // than reporting a failure that may not have happened.
            throw new Error("retryable");
          }
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (payload) {
              if (!response.ok) {
                finish(payload.error || "That could not be saved.", "error");
                return;
              }
              form.dataset.idempotencyKey = "";
              if (payload.redirect) {
                // Clear the form's own status first — the message is about to
                // be shown against the refreshed page instead.
                finish("", null);
                updatePage(payload.redirect, payload.message || "Saved.", "success");
                return;
              }
              finish(payload.message || "Saved.", "success");
              if (form.dataset.reloadOnSuccess !== "false") {
                updatePage(window.location.pathname + window.location.search, null, null);
              }
            });
        })
        .catch(function () {
          attempt++;
          if (attempt <= RETRY_DELAYS.length) {
            setStatus(form, "Still trying… (attempt " + (attempt + 1) + ")", null);
            setTimeout(tryOnce, RETRY_DELAYS[attempt - 1]);
            return;
          }
          // 08 §12: name the cause and the next step, and distinguish the two
          // failures that look alike. The typed input stays exactly where it is.
          finish(
            navigator.onLine
              ? "The server didn't answer. Your entry is still here — try again?"
              : "You appear to be offline. Your entry is still here — try again when you have signal.",
            "error"
          );
        });
    }

    tryOnce();
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.method.toLowerCase() !== "post") return;
    if (form.dataset.noRetry === "true") return;
    if (!window.fetch) return; // Plain form post still works without JS.
    // A file upload cannot be sent as URL-encoded — serialising a FormData with
    // a File through URLSearchParams turns the file into the string
    // "[object File]" and its bytes are lost. Let multipart forms (statement
    // PDFs, CSV files, receipts) submit natively; the browser follows the
    // server's redirect to the result page.
    if (
      form.enctype === "multipart/form-data" ||
      form.querySelector('input[type="file"]')
    ) {
      return;
    }
    event.preventDefault();
    submitWithRetry(form);
  });

  // Carry the current URL into the theme toggle so it returns you here (R39.5).
  document.querySelectorAll('input[name="return_to"]').forEach(function (input) {
    if (!input.value) input.value = window.location.pathname + window.location.search;
  });

  // ---------------------------------------------------------------------------
  // Inline assign (F3.8) — commit on blur or Enter, revert on Escape
  // ---------------------------------------------------------------------------
  // B51: reveal/hide a target element when a control changes, declaratively.
  // The CSP forbids inline onchange handlers (script-src self), so a control
  // that carried its logic in an onchange attribute silently did nothing. A
  // control marks itself with data-reveal set to a target element id and,
  // optionally, data-reveal-when set to a string (and data-reveal-prefix to
  // match a prefix rather than the whole value). The target shows when the
  // control value matches. Runs once on load and on every change.
  function applyReveal(control) {
    if (!control || !control.dataset || control.dataset.reveal === undefined) return;
    var target = document.getElementById(control.dataset.reveal);
    if (!target) return;
    var when = control.dataset.revealWhen;
    var value = control.value || "";
    var show = when === undefined
      ? Boolean(value)
      : control.dataset.revealPrefix !== undefined
        ? value.indexOf(when) === 0
        : value === when;
    target.style.display = show ? "" : "none";
  }
  document.addEventListener("change", function (event) {
    applyReveal(event.target);
  });
  document.querySelectorAll("[data-reveal]").forEach(applyReveal);

  document.addEventListener("focusin", function (event) {
    var input = event.target;
    if (input && input.dataset && input.dataset.assignInput !== undefined) {
      input.dataset.originalValue = input.value;
      input.select();
    }
  });

  document.addEventListener("keydown", function (event) {
    var input = event.target;
    if (!input || !input.dataset || input.dataset.assignInput === undefined) return;
    if (event.key === "Escape") {
      input.value = input.dataset.originalValue || "";
      input.blur();
    }
  });

  document.addEventListener("focusout", function (event) {
    var input = event.target;
    if (!input || !input.dataset || input.dataset.assignInput === undefined) return;
    if (input.value === input.dataset.originalValue) return;
    var form = input.closest("form");
    if (form) form.requestSubmit();
  });

  // ---------------------------------------------------------------------------
  // B99 · An expense names its envelope; income does not have to
  //
  // The add form carries both the direction and the category, so the
  // requirement has to follow the dropdown rather than being fixed in the
  // markup. The server enforces it regardless — this only means the household
  // is told before submitting rather than after.
  // ---------------------------------------------------------------------------
  function syncCategoryRequirement() {
    var direction = document.getElementById("direction");
    var category = document.querySelector("[data-requires-category]");
    if (!direction || !category) return;

    var isExpense = direction.value !== "in";
    category.required = isExpense;
    var blank = category.querySelector('option[value=""]');
    if (blank) {
      blank.textContent = isExpense
        ? "Choose where it came from…"
        : "No category needed — it lands in Ready to Assign";
    }
  }

  document.addEventListener("change", function (event) {
    if (event.target && event.target.id === "direction") syncCategoryRequirement();
  });
  syncCategoryRequirement();

  // ---------------------------------------------------------------------------
  // B87 · Filter the budget grid
  //
  // Thirty-four categories is seven screens on a phone. Typing filters to what
  // matches; the toggle narrows to what is short of its target or overspent.
  // A group with nothing left in it hides itself, so the result reads as a
  // short list rather than a page of empty headings.
  //
  // Runs on the client because a round trip per keystroke would be worse than
  // scrolling, and stores nothing: it is a lens over the page, and it is gone
  // the moment the page is.
  // ---------------------------------------------------------------------------
  function applyBudgetFilter() {
    var box = document.querySelector("[data-budget-filter]");
    var onlyNeedy = document.querySelector("[data-budget-underfunded]");
    if (!box && !onlyNeedy) return;

    var term = box ? box.value.trim().toLowerCase() : "";
    var needyOnly = onlyNeedy ? onlyNeedy.checked : false;
    var shown = 0;
    var total = 0;

    document.querySelectorAll(".category-row").forEach(function (row) {
      total++;
      var name = (row.getAttribute("data-category-name") || "").toLowerCase();
      var matches = !term || name.indexOf(term) >= 0;
      var needy = row.hasAttribute("data-needs-money");
      var visible = matches && (!needyOnly || needy);
      row.hidden = !visible;
      if (visible) shown++;
    });

    // A group whose every row is hidden is noise; open the ones that survive so
    // a match inside a collapsed group is not filtered into invisibility.
    var filtering = Boolean(term) || needyOnly;
    document.querySelectorAll("details.category-group").forEach(function (group) {
      var any = false;
      group.querySelectorAll(".category-row").forEach(function (row) {
        if (!row.hidden) any = true;
      });
      group.hidden = filtering && !any;
      if (filtering && any) group.open = true;
    });

    var count = document.querySelector("[data-budget-filter-count]");
    if (count) {
      count.hidden = !filtering;
      count.textContent = shown === 0
        ? "Nothing matches."
        : "Showing " + shown + " of " + total + ".";
    }
  }

  document.addEventListener("input", function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute("data-budget-filter")) {
      applyBudgetFilter();
    }
  });
  document.addEventListener("change", function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute("data-budget-underfunded")) {
      applyBudgetFilter();
    }
  });

  // ---------------------------------------------------------------------------
  // B82 · A payee remembers where its money goes
  //
  // payeeStats already knows the category a payee's spending usually lands in,
  // and the add form already received it — it simply never used it. Picking a
  // known payee now fills the category in.
  //
  // Two rules keep it a convenience rather than a surprise: it only ever fills
  // a category that is still unset, so a deliberate choice is never overridden,
  // and it says what it did, because a field that changes by itself with no
  // explanation is worse than one that stays empty.
  // ---------------------------------------------------------------------------
  function applyUsualCategory() {
    var payee = document.getElementById("payee");
    var category = document.getElementById("category_id");
    if (!payee || !category || category.value !== "") return;

    var list = document.getElementById("payee-options");
    if (!list) return;
    var typed = payee.value.trim().toLowerCase();
    if (!typed) return;

    var match = null;
    list.querySelectorAll("option").forEach(function (option) {
      if (option.value.trim().toLowerCase() === typed) match = option;
    });
    if (!match) return;

    var usual = match.getAttribute("data-category");
    if (!usual) return;
    // The category may be hidden or gone; only select one that is really there.
    var option = category.querySelector('option[value="' + usual + '"]');
    if (!option) return;

    category.value = usual;
    var hint = document.querySelector("[data-category-hint]");
    if (hint) {
      hint.textContent =
        "Filled in from where " + match.value + " usually goes. Change it if this one is different.";
    }
  }

  document.addEventListener("change", function (event) {
    if (event.target && event.target.id === "payee") applyUsualCategory();
  });
  document.addEventListener("blur", function (event) {
    if (event.target && event.target.id === "payee") applyUsualCategory();
  }, true);

  // ---------------------------------------------------------------------------
  // F29 · Command palette
  //
  // F29.5: never the only route to any action — everything here is also
  // reachable by navigation.
  // ---------------------------------------------------------------------------
  var palette = null;

  function buildPalette() {
    var dialog = document.createElement("dialog");
    dialog.id = "command-palette";
    dialog.innerHTML =
      '<form method="dialog"><label for="palette-input">Go to, do, or find</label>' +
      '<input id="palette-input" type="search" autocomplete="off" placeholder="Type a screen, an action, or a search term">' +
      '</form><ul class="explain-list" id="palette-results"></ul>';
    document.body.appendChild(dialog);
    return dialog;
  }

  // F29: every screen and action. A 'feature' marks a command that belongs to
  // a module; F28.2 hides it when that module is off, so a disabled module
  // never appears in the palette any more than in the navigation.
  var ALL_COMMANDS = [
    { label: "Go to Budget", href: "/", group: "Go to" },
    { label: "Go to Accounts", href: "/accounts", group: "Go to" },
    { label: "Go to Cards", href: "/cards", group: "Go to" },
    { label: "Go to Review", href: "/review", group: "Go to" },
    { label: "Go to Overview", href: "/overview", group: "Go to" },
    { label: "Go to Reports", href: "/reports", group: "Go to" },
    { label: "Go to Query", href: "/query", group: "Go to" },
    { label: "Go to Schedules", href: "/schedules", group: "Go to" },
    { label: "Go to Goals", href: "/goals", group: "Go to" },
    { label: "Go to Loans", href: "/loans", group: "Go to", feature: "loans" },
    { label: "Go to Portfolio", href: "/portfolio", group: "Go to", feature: "assets" },
    { label: "Go to Net worth", href: "/net-worth", group: "Go to", feature: "assets" },
    { label: "Go to Allocation", href: "/portfolio/allocation", group: "Go to", feature: "assets" },
    { label: "Go to Lending in the family", href: "/family", group: "Go to" },
    { label: "Go to Payees", href: "/payees", group: "Go to" },
    { label: "Go to Rules", href: "/rules", group: "Go to" },
    { label: "Go to Import", href: "/import", group: "Go to" },
    { label: "Go to Month close", href: "/months", group: "Go to" },
    { label: "Go to Activity", href: "/activity", group: "Go to" },
    { label: "Go to Health", href: "/health", group: "Go to" },
    { label: "Go to Settings", href: "/settings", group: "Go to" },
    { label: "Add a transaction", href: "/add", group: "Do", shortcut: "A" },
    { label: "Move money between categories", href: "/move", group: "Do" },
    { label: "Auto-assign this month", href: "/auto-assign", group: "Do" },
    { label: "Reconcile an account", href: "/accounts", group: "Do" },
    { label: "Import a CAS", href: "/portfolio/cas", group: "Do", feature: "assets" },
    { label: "Prepayment calculator", href: "/loans/what-if", group: "Do", feature: "loans" },
    { label: "Toggle theme", href: "/settings/theme-toggle", group: "Do" },
  ];

  function enabledFeatures() {
    var attr = (document.body.getAttribute("data-features") || "").split(" ");
    var set = {};
    attr.forEach(function (f) { if (f) set[f] = true; });
    return set;
  }

  var COMMANDS = (function () {
    var features = enabledFeatures();
    return ALL_COMMANDS.filter(function (c) { return !c.feature || features[c.feature]; });
  })();

  function renderResults(query) {
    var results = document.getElementById("palette-results");
    if (!results) return;
    var q = query.trim().toLowerCase();
    var matches = COMMANDS.filter(function (c) {
      return !q || c.label.toLowerCase().indexOf(q) >= 0;
    }).slice(0, 8);

    results.innerHTML = "";
    matches.forEach(function (c) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = c.href;
      a.textContent = c.label;
      li.appendChild(a);
      var group = document.createElement("span");
      group.className = "chip";
      group.style.marginLeft = ".5rem";
      group.textContent = c.group;
      li.appendChild(group);
      results.appendChild(li);
    });

    if (q) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "/search?q=" + encodeURIComponent(query);
      a.textContent = 'Search transactions for "' + query + '"';
      li.appendChild(a);
      results.appendChild(li);
    }
  }

  function openPalette() {
    if (!palette) {
      palette = buildPalette();
      var input = palette.querySelector("#palette-input");
      input.addEventListener("input", function () {
        renderResults(input.value);
      });
      // F29.3/F29.4: keyboard-navigable from open to execution.
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          var first = palette.querySelector("#palette-results a");
          if (first) {
            event.preventDefault();
            window.location.href = first.getAttribute("href");
          }
        }
        if (event.key === "ArrowDown") {
          var link = palette.querySelector("#palette-results a");
          if (link) {
            event.preventDefault();
            link.focus();
          }
        }
      });
    }
    renderResults("");
    palette.showModal();
    palette.querySelector("#palette-input").focus();
  }

  /*
   * A link to "#edit" should open the disclosure it points at. Browsers do this
   * for content *inside* a <details>, but not reliably for the element itself,
   * and the Edit button on an account is exactly that case.
   */
  function openTargetedDetails() {
    var id = window.location.hash.slice(1);
    if (!id) return;
    var target = document.getElementById(id);
    if (target && target.tagName === "DETAILS") target.open = true;
  }
  window.addEventListener("hashchange", openTargetedDetails);
  openTargetedDetails();

  document.addEventListener("keydown", function (event) {
    var typing =
      event.target &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || "");

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
      return;
    }
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      window.location.href = "/search";
    }
    if (event.key.toLowerCase() === "a" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      window.location.href = "/add";
    }
  });

  // ---------------------------------------------------------------------------
  // F25.10 · "Explain this number"
  // ---------------------------------------------------------------------------
  document.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("[data-explain]") : null;
    if (!link) return;
    event.preventDefault();

    var dialog = document.getElementById("explain-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "explain-dialog";
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = '<p class="faint">Loading…</p>';
    dialog.showModal();

    fetch(link.getAttribute("href"), {
      headers: { Accept: "text/html" },
      credentials: "same-origin",
    })
      .then(function (r) {
        return r.text();
      })
      .then(function (markup) {
        dialog.innerHTML =
          markup + '<form method="dialog"><button type="submit">Close</button></form>';
      })
      .catch(function () {
        // R35.3: never paper over a failed request with a stale value.
        dialog.innerHTML =
          '<p class="notice notice-error">Couldn\'t reach the server, so this number can\'t be explained right now.</p>' +
          '<form method="dialog"><button type="submit">Close</button></form>';
      });
  });
})();
`;
