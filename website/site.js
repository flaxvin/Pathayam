/*
 * Pathayam — site behaviour.
 *
 * Two things: the theme toggle, and the envelope demo. The demo is a faithful
 * miniature of the real engine's arithmetic — assigned minus activity is
 * available, and Ready to Assign is income minus everything assigned — because
 * a demo that rounds the model off teaches the wrong thing about a product
 * whose whole claim is that the model is exact.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------- theme -- */
  var root = document.documentElement;

  function store(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function read(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  var saved = read("pathayam-theme");
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);

  function resolved() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    var paint = function () {
      var next = resolved() === "dark" ? "light" : "dark";
      toggle.textContent = resolved() === "dark" ? "☀" : "☾";
      toggle.setAttribute("aria-label", "Switch to " + next + " theme");
      toggle.setAttribute("title", "Switch to " + next + " theme");
    };
    paint();
    toggle.addEventListener("click", function () {
      var next = resolved() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store("pathayam-theme", next);
      paint();
    });
  }

  /* ---------------------------------------------------------- waitlist -- */
  /*
   * Paste the Apps Script /exec URL here and the form starts working. See
   * waitlist.gs for the script and the five-step setup.
   *
   * Left empty on purpose until then: a signup box that silently swallows
   * addresses is worse than one that admits it is not connected, because the
   * only way anyone finds out is by never hearing back.
   */
  var WAITLIST_ENDPOINT = "";

  document.querySelectorAll("[data-waitlist]").forEach(function (form) {
    var msg = form.querySelector("[data-waitlist-msg]");
    var email = form.querySelector("input[type=email]");
    var trap = form.querySelector("input[name=company]");
    var button = form.querySelector("button");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = (email.value || "").trim();

      /* Stricter than the browser's own check, which accepts `a@b`. */
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        say("That does not look like an email address.", "err");
        email.focus();
        return;
      }
      if (!WAITLIST_ENDPOINT) {
        say("The waitlist is not connected yet — nothing was sent. " +
            "Until it is, the repository is the way in.", "err");
        return;
      }

      button.disabled = true;
      say("Sending…", "");

      /*
       * `no-cors` with a text/plain body: an Apps Script web app does not send
       * CORS headers, and this shape avoids the preflight it would fail. The
       * cost is that the response is opaque — a resolved promise means the
       * request left the browser, not that the row was written. Worth knowing
       * before trusting the count in the sheet over the count here.
       */
      fetch(WAITLIST_ENDPOINT, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          email: value,
          tier: form.getAttribute("data-waitlist") || "unknown",
          page: location.pathname,
          company: trap ? trap.value : "",
        }),
      }).then(function () {
        form.reset();
        say("You are on the list. We will write once, when it opens.", "ok");
      }).catch(function () {
        say("That did not go through. Try again in a moment.", "err");
      }).then(function () {
        button.disabled = false;
      });
    });

    function say(text, kind) {
      msg.textContent = text;
      msg.className = "waitlist__msg" + (kind ? " " + kind : "");
    }
  });

  /* -------------------------------------------------------------- demo -- */
  var demo = document.querySelector("[data-demo]");
  if (!demo) return;

  /*
   * A working miniature of the engine. Every rule it enforces is one the real
   * app enforces, because a demo that rounds the model off teaches the wrong
   * thing about a product whose whole claim is that the model is exact:
   *
   *   available          = carried + assigned - activity
   *   Ready to Assign    = income + held - Σ assigned
   *   card spending      moves money from the category to the payment envelope,
   *                      so the cash to clear the debt is reserved at once
   *   rollover           carries leftovers, and handles overspend under
   *                      whichever of the two models is selected
   */
  var MONTHS = ["September", "October", "November", "December", "January", "February"];
  var INCOME = 145000;

  var SEED = [
    { group: "Bills",     name: "Rent",           target: 45000, activity: 45000, assigned: 45000, carried: 0 },
    { group: "Bills",     name: "Electricity",    target: 2400,  activity: 2180,  assigned: 2400,  carried: 0 },
    { group: "Bills",     name: "Internet",       target: 1200,  activity: 1200,  assigned: 1200,  carried: 0 },
    { group: "Bills",     name: "Maintenance",    target: 3300,  activity: 3300,  assigned: 3300,  carried: 0 },
    { group: "Flexible",  name: "Groceries",      target: 14000, activity: 12460, assigned: 14000, carried: 0 },
    { group: "Flexible",  name: "Eating out",     target: 6000,  activity: 5320,  assigned: 4000,  carried: 0 },
    { group: "Flexible",  name: "Transport",      target: 3500,  activity: 2890,  assigned: 3500,  carried: 0 },
    { group: "Cards",     name: "Swiggy HDFC payment", target: 11600, activity: 0, assigned: 11600, carried: 0, card: true },
    { group: "Goals",     name: "Emergency fund", target: 58000, activity: 0,     assigned: 0,     carried: 0 }
  ];

  var st;
  function reset() {
    st = {
      monthIx: 0,
      income: INCOME,
      heldForNext: 0,
      cardDebt: 11600,
      model: "reduce-rta",
      rows: SEED.map(function (r) {
        return { group: r.group, name: r.name, target: r.target, activity: r.activity,
                 assigned: r.assigned, carried: r.carried, card: !!r.card };
      }),
      log: []
    };
  }
  reset();

  function groupIndian(n) {
    var s = String(Math.abs(Math.round(n)));
    if (s.length <= 3) return s;
    return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  }
  function rupees(n) { return (n < 0 ? "-₹" : "₹") + groupIndian(n); }
  function avail(r) { return r.carried + r.assigned - r.activity; }
  function assignedTotal() {
    return st.rows.reduce(function (a, r) { return a + r.assigned; }, 0);
  }
  function rta() { return st.income - st.heldForNext - assignedTotal(); }
  function cardRow() {
    return st.rows.filter(function (r) { return r.card; })[0];
  }

  var el = {
    rta:   demo.querySelector("[data-rta]"),
    rows:  demo.querySelector("[data-rows]"),
    msg:   demo.querySelector("[data-msg]"),
    month: demo.querySelector("[data-month]"),
    debt:  demo.querySelector("[data-debt]"),
    log:   document.querySelector("[data-log]"),
    cat:   demo.querySelector("[data-cat]")
  };

  function note(text) {
    st.log.unshift(text);
    if (st.log.length > 8) st.log.pop();
  }

  function render() {
    var r2a = rta();
    el.rta.textContent = rupees(r2a);
    el.rta.classList.toggle("is-zero", r2a === 0);
    el.rta.classList.toggle("is-neg", r2a < 0);
    el.month.textContent = MONTHS[st.monthIx] + " 2026";
    if (el.debt) el.debt.textContent = rupees(st.cardDebt);

    var lastGroup = null, html = "";
    st.rows.forEach(function (r, i) {
      if (r.group !== lastGroup) {
        html += '<div class="row__group">' + r.group + "</div>";
        lastGroup = r.group;
      }
      var a = avail(r);
      var cls = a < 0 ? "over" : a === 0 ? "zero" : "ok";
      html +=
        '<div class="row">' +
          '<div class="row__name">' + r.name +
            (r.card ? ' <span class="tagly">managed</span>' : "") +
            (r.carried ? ' <span class="tagly">+' + rupees(r.carried) + " carried</span>" : "") +
          "</div>" +
          '<div data-col="Assigned"><label class="sr-only" for="a' + i + '">Assign to ' + r.name + "</label>" +
            '<input class="assign-input" id="a' + i + '" data-i="' + i + '" type="text" ' +
                   'inputmode="numeric" value="' + (r.assigned ? groupIndian(r.assigned) : "") +
                   '" placeholder="0"></div>' +
          '<div class="num" data-col="Activity" style="color:var(--muted)">' + (r.activity ? rupees(-r.activity) : "—") + "</div>" +
          '<div class="num avail ' + cls + '" data-col="Available">' + rupees(a) +
            (a < 0 ? ' <button class="cover" type="button" data-cover="' + i + '">cover</button>' : "") +
          "</div>" +
        "</div>";
    });
    el.rows.innerHTML = html;

    if (el.cat) {
      el.cat.innerHTML = st.rows.map(function (r, i) {
        return r.card ? "" : '<option value="' + i + '">' + r.name + "</option>";
      }).join("");
    }

    if (el.log) {
      el.log.innerHTML = st.log.length
        ? st.log.map(function (t) { return "<li>" + t + "</li>"; }).join("")
        : '<li class="muted">Nothing yet. Try spending something.</li>';
    }

    var over = st.rows.filter(function (r) { return avail(r) < 0; });
    if (r2a < 0) {
      say("You have assigned more than you have. Ready to Assign is never allowed to stay negative — take some back.");
    } else if (over.length) {
      say(over.length + (over.length === 1 ? " envelope is" : " envelopes are") +
          " overspent. Cover it from another envelope, or let the rollover handle it.");
    } else if (r2a === 0) {
      say("Every rupee has a job. That is the whole idea.");
    } else {
      say(rupees(r2a) + " still has no job.");
    }
  }
  function say(t) { el.msg.textContent = t; }

  /* Typing repaints only the derived figures, so the caret is never stolen. */
  el.rows.addEventListener("input", function (e) {
    var input = e.target.closest(".assign-input");
    if (!input) return;
    var i = Number(input.getAttribute("data-i"));
    var v = parseInt(input.value.replace(/[^0-9]/g, ""), 10);
    st.rows[i].assigned = isNaN(v) ? 0 : v;

    var r2a = rta();
    el.rta.textContent = rupees(r2a);
    el.rta.classList.toggle("is-zero", r2a === 0);
    el.rta.classList.toggle("is-neg", r2a < 0);

    var cell = input.closest(".row").querySelector(".avail");
    var a = avail(st.rows[i]);
    cell.textContent = rupees(a);
    cell.className = "num avail " + (a < 0 ? "over" : a === 0 ? "zero" : "ok");
  });
  el.rows.addEventListener("focusout", function () { window.setTimeout(render, 0); });

  /* Cover an overspend from wherever has the most slack — the app ranks the
     same way, which is why this is one tap there too. */
  el.rows.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-cover]");
    if (!btn) return;
    var i = Number(btn.getAttribute("data-cover"));
    var need = -avail(st.rows[i]);
    var best = -1, bestSlack = 0;
    st.rows.forEach(function (r, j) {
      /* Never a payment envelope: draining one leaves the card unfunded, which
         is the problem the envelope exists to prevent. The app ranks the same
         way, and for the same reason. */
      if (j === i || r.card) return;
      var s = avail(r);
      if (s > bestSlack) { bestSlack = s; best = j; }
    });
    if (best < 0 || bestSlack < need) {
      say("Nothing has enough slack to cover it. Take it from Ready to Assign, or let the rollover deal with it.");
      return;
    }
    st.rows[best].assigned -= need;
    st.rows[i].assigned += need;
    note("Moved " + rupees(need) + " from " + st.rows[best].name + " to " + st.rows[i].name + ".");
    render();
  });

  demo.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");

    if (act === "targets") {
      var left = st.income - st.heldForNext;
      st.rows.forEach(function (r) {
        var give = Math.max(0, Math.min(r.target - r.carried, left));
        r.assigned = give; left -= give;
      });
      note("Funded every target, in budget order.");

    } else if (act === "spend") {
      var i = Number(demo.querySelector("[data-cat]").value);
      var amt = parseInt((demo.querySelector("[data-amt]").value || "").replace(/[^0-9]/g, ""), 10);
      var onCard = demo.querySelector("[data-card]").checked;
      if (!amt) { say("Put an amount in first."); return; }
      st.rows[i].activity += amt;
      if (onCard) {
        /* R6: the category gives the money up and the payment envelope holds it,
           so the cash to clear the debt is reserved the moment the charge lands. */
        cardRow().carried += amt;
        st.cardDebt += amt;
        note("Spent " + rupees(amt) + " on " + st.rows[i].name + " with the card. " +
             rupees(amt) + " moved into the payment envelope.");
      } else {
        note("Spent " + rupees(amt) + " on " + st.rows[i].name + " from the bank.");
      }

    } else if (act === "paycard") {
      if (!st.cardDebt) { say("Nothing owed on the card."); return; }
      var c = cardRow(), pot = avail(c);
      if (pot < st.cardDebt) {
        say("The payment envelope only holds " + rupees(pot) + " against " + rupees(st.cardDebt) +
            " owed. Fund the difference first — that gap is the warning doing its job.");
        return;
      }
      c.activity += st.cardDebt;
      note("Paid " + rupees(st.cardDebt) + " off the card. The envelope emptied; no category was touched.");
      st.cardDebt = 0;

    } else if (act === "hold") {
      var spare = rta();
      if (spare <= 0) { say("There is nothing spare to hold."); return; }
      st.heldForNext += spare;
      note("Held " + rupees(spare) + " back for next month.");

    } else if (act === "roll") {
      var deficit = 0;
      st.rows.forEach(function (r) {
        var a = avail(r);
        if (a < 0 && st.model === "reduce-rta") { deficit += -a; a = 0; }
        r.carried = a; r.assigned = 0; r.activity = 0;
      });
      st.monthIx = Math.min(st.monthIx + 1, MONTHS.length - 1);
      var broughtForward = st.heldForNext;
      st.income = INCOME - deficit + broughtForward;
      st.heldForNext = 0;
      note("Rolled into " + MONTHS[st.monthIx] + ". Leftovers carried" +
           (deficit ? ", and " + rupees(deficit) + " of overspend came off Ready to Assign" : "") +
           (broughtForward ? ", plus " + rupees(broughtForward) + " held from last month" : "") + ".");

    } else if (act === "model") {
      st.model = st.model === "reduce-rta" ? "carry-negative" : "reduce-rta";
      btn.textContent = st.model === "reduce-rta"
        ? "Overspend: reduce next month" : "Overspend: carry the negative";
      note("Overspend model is now " +
           (st.model === "reduce-rta" ? "reduce next month's Ready to Assign" : "carry the negative category") + ".");

    } else if (act === "reset") {
      reset();
    }
    render();
  });

  /* Tabs, as plain buttons so the panels stay in the document for search. */
  demo.parentElement.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab]");
    if (!t) return;
    var name = t.getAttribute("data-tab");
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b === t));
    });
    document.querySelectorAll("[data-panel]").forEach(function (p) {
      p.hidden = p.getAttribute("data-panel") !== name;
    });
  });

  render();
})();
