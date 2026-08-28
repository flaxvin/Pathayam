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
              if (payload.redirect) {
                window.location.href = payload.redirect;
                return;
              }
              form.dataset.idempotencyKey = "";
              finish(payload.message || "Saved.", "success");
              if (form.dataset.reloadOnSuccess !== "false") {
                window.location.reload();
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
    { label: "Go to Review", href: "/review", group: "Go to" },
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
