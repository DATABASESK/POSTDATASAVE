// Dashboard for the sulekha_records table. Works as an extension page (dashboard.html opened from the
// side panel) and as a plain file opened in a browser — it only talks to Supabase over HTTPS.
(function () {
  "use strict";

  const DEFAULT_URL = "https://tsjkkicdaflxzdncupno.supabase.co";
  const DEFAULT_KEY = "sb_publishable_R-wQAOCiOYaHt6syxcvTLg_keHCBYcz";
  const TABLE = "sulekha_records";
  const BUCKET = "sulekha-logos";

  const $ = (id) => document.getElementById(id);
  let rows = [];
  let filter = "all"; // all | nologo | nomobile
  let expanded = null;
  let pickFor = null;
  const selected = new Set();

  // ---------- config ----------
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }
  function cfg() {
    return {
      url: ((store("sbUrl") || DEFAULT_URL) + "").trim().replace(/\/+$/, ""),
      key: ((store("sbKey") || DEFAULT_KEY) + "").trim(),
    };
  }
  function headers(extra) {
    const c = cfg();
    return Object.assign({ apikey: c.key, Authorization: "Bearer " + c.key }, extra || {});
  }

  // ---------- helpers ----------
  function msg(text, type) {
    const el = $("msg");
    el.textContent = text;
    el.className = "msg show " + (type || "info");
    if (type === "ok") setTimeout(() => (el.className = "msg"), 4000);
  }
  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    (children || []).forEach((c) => c && n.appendChild(c));
    return n;
  }
  const bareName = (r) => (r.business_name || "").replace(/^\d+\s*-\s*/, "") || "(no name)";
  const hasLogo = (r) => !!r.logo_url;
  const hasText = (v) => !!(v && String(v).trim());
  function infoCell(text, max) {
    if (!hasText(text)) return el("span", { class: "pill warn", text: "Not available" });
    const t = String(text).trim();
    return el("span", { text: t.length > max ? t.slice(0, max) + "…" : t, title: t });
  }
  function logoState(r) {
    if (r.logo_url) return { key: "ok", label: r.logo_status === "manual" ? "Added manually" : "In cloud", cls: "ok" };
    if (r.logo_status === "upload_failed") return { key: "failed", label: "Upload failed — retrying", cls: "warn" };
    return { key: "missing", label: "No logo", cls: "bad" };
  }
  function csvCell(v) {
    return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- data ----------
  async function load() {
    $("sub").textContent = "Loading…";
    const all = [];
    const page = 1000;
    try {
      for (let from = 0; from < 20000; from += page) {
        const r = await fetch(`${cfg().url}/rest/v1/${TABLE}?select=*&order=updated_at.desc`, {
          headers: headers({ "Range-Unit": "items", Range: `${from}-${from + page - 1}` }),
        });
        if (!r.ok) throw new Error(friendly(r.status, await r.text().catch(() => "")));
        const batch = await r.json();
        all.push(...batch);
        if (batch.length < page) break;
      }
      rows = all;
      $("msg").className = "msg";
    } catch (e) {
      msg(e.message, "err");
      rows = [];
    }
    render();
  }
  function friendly(status, text) {
    if (status === 404 || /PGRST205|does not exist|schema cache/i.test(text)) return "Table not found — run supabase-setup.sql once in Supabase → SQL Editor.";
    if (status === 401 || status === 403) return "Supabase refused the key or the table policy — run supabase-setup.sql once.";
    return `Supabase ${status}: ${text.slice(0, 160)}`;
  }

  async function uploadLogo(row, file) {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[file.type] || "jpg";
    const path = `${encodeURIComponent(row.customer_id)}.${ext}`;
    const up = await fetch(`${cfg().url}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: headers({ "Content-Type": file.type || "image/jpeg", "x-upsert": "true" }),
      body: file,
    });
    if (!up.ok) {
      const t = await up.text().catch(() => "");
      if (up.status === 404 || /bucket not found/i.test(t)) throw new Error("Logo bucket missing — run supabase-setup.sql once.");
      if (up.status === 401 || up.status === 403 || /row-level security/i.test(t)) throw new Error("Not allowed to upload — run supabase-setup.sql once.");
      throw new Error(`Storage ${up.status}: ${t.slice(0, 120)}`);
    }
    const publicUrl = `${cfg().url}/storage/v1/object/public/${BUCKET}/${path}`;
    const patch = await fetch(`${cfg().url}/rest/v1/${TABLE}?customer_id=eq.${encodeURIComponent(row.customer_id)}`, {
      method: "PATCH",
      headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ logo_url: publicUrl, logo_status: "manual", updated_at: new Date().toISOString() }),
    });
    if (!patch.ok) {
      const t = await patch.text().catch(() => "");
      if (/logo_(url|status)/i.test(t)) throw new Error("The table has no logo columns yet — run supabase-setup.sql once.");
      throw new Error(`Saved the file but not the record (${patch.status}): ${t.slice(0, 120)}`);
    }
    row.logo_url = publicUrl;
    row.logo_status = "manual";
  }

  // ---------- render ----------
  function matches(r, q) {
    if (filter === "nologo" && hasLogo(r)) return false;
    if (filter === "nomobile" && r.owner_mobile) return false;
    if (filter === "noinfo" && hasText(r.about) && hasText(r.services)) return false;
    if (!q) return true;
    return [r.customer_id, r.business_id, r.business_name, r.owner_mobile, r.address].join(" ").toLowerCase().includes(q);
  }

  function renderTiles() {
    const total = rows.length;
    const withLogo = rows.filter(hasLogo).length;
    const noMobile = rows.filter((r) => !r.owner_mobile).length;
    const noInfo = rows.filter((r) => !hasText(r.about) || !hasText(r.services)).length;
    const defs = [
      { key: "all", n: total, l: "Customers saved" },
      { key: "withlogo", n: withLogo, l: "With logo in cloud", noclick: true },
      { key: "nologo", n: total - withLogo, l: "Logo not available / to add", warn: total - withLogo > 0 },
      { key: "nomobile", n: noMobile, l: "No mobile found", warn: noMobile > 0 },
      { key: "noinfo", n: noInfo, l: "About / services not available", warn: noInfo > 0 },
    ];
    const box = $("tiles");
    box.innerHTML = "";
    defs.forEach((d) => {
      const t = el("button", { class: "tile" + (filter === d.key ? " on" : "") + (d.warn ? " warn" : ""), type: "button" }, [
        el("div", { class: "n", text: String(d.n) }),
        el("div", { class: "l", text: d.l }),
      ]);
      if (!d.noclick) t.addEventListener("click", () => { filter = filter === d.key ? "all" : d.key; render(); });
      box.appendChild(t);
    });
  }

  function logoCell(r) {
    const src = r.logo_url;
    if (src) {
      const img = el("img", { class: "logo", alt: bareName(r), loading: "lazy", src: src + (r.logo_status === "manual" ? "?v=" + encodeURIComponent(r.updated_at || "") : "") });
      img.addEventListener("error", () => img.replaceWith(el("div", { class: "logo ph", text: "!" })));
      return img;
    }
    return el("div", { class: "logo ph", text: (bareName(r)[0] || "?").toUpperCase() });
  }

  function render() {
    renderTiles();
    const q = $("q").value.trim().toLowerCase();
    const shown = rows.filter((r) => matches(r, q));
    selected.forEach((id) => { if (!rows.some((r) => r.customer_id === id)) selected.delete(id); });
    $("sub").textContent = rows.length
      ? `${shown.length} of ${rows.length} customers · live from Supabase`
      : "No customers saved yet";
    const tbody = $("rows");
    tbody.innerHTML = "";
    const empty = $("empty");
    updateSel();
    if (!shown.length) {
      empty.style.display = "block";
      empty.textContent = rows.length ? "No customers match this filter." : "Nothing here yet — run customer IDs from the extension and they appear automatically.";
      return;
    }
    empty.style.display = "none";

    shown.forEach((r) => {
      const st = logoState(r);
      const services = r.services || "";
      const cb = el("input", { type: "checkbox", title: "Select" });
      cb.checked = selected.has(r.customer_id);
      cb.addEventListener("change", () => { cb.checked ? selected.add(r.customer_id) : selected.delete(r.customer_id); updateSel(); });
      const tr = el("tr", { class: "row" }, [
        el("td", {}, [cb]),
        el("td", {}, [logoCell(r)]),
        el("td", { class: "cid", text: r.customer_id }),
        el("td", {}, [el("span", { class: "name", text: bareName(r), onclick: () => { expanded = expanded === r.customer_id ? null : r.customer_id; render(); } })]),
        el("td", { text: r.owner_mobile || "—", class: r.owner_mobile ? "" : "muted" }),
        el("td", { class: "hide" }, [infoCell(r.about, 80)]),
        el("td", { class: "hide" }, [infoCell(services, 70)]),
        el("td", {}, [el("span", { class: "pill " + st.cls, text: st.label })]),
        el("td", {}, [el("div", { class: "acts" }, [
          el("button", { type: "button", text: hasLogo(r) ? "Replace logo" : "Add logo", onclick: () => { pickFor = r; $("filePick").click(); } }),
          r.owner_mobile ? el("button", { type: "button", text: "Copy mobile", onclick: (e) => { navigator.clipboard.writeText(r.owner_mobile).then(() => { e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy mobile"), 1100); }); } }) : null,
          el("button", { type: "button", class: "danger", text: "Delete", onclick: () => removeWithConfirm([r]) }),
          r.profile_url ? el("a", { class: "btn", href: r.profile_url, target: "_blank", rel: "noopener", text: "Profile" }) : null,
        ])]),
      ]);
      tbody.appendChild(tr);

      if (expanded === r.customer_id) {
        const kv = (k, v) => [el("div", { class: "k", text: k }), el("div", { text: v || "—" })];
        const grid = el("div", { class: "dgrid" }, [
          ...kv("Business ID", r.business_id),
          ...kv("Address", r.address),
          ...kv("Services", hasText(r.services) ? r.services : "Not available"),
          ...kv("About", hasText(r.about) ? r.about : "Not available"),
          ...kv("Titles", r.titles),
          ...kv("Logo source", r.logo_source_url),
          ...kv("Updated", r.updated_at ? new Date(r.updated_at).toLocaleString() : ""),
        ]);
        tbody.appendChild(el("tr", { class: "detail" }, [el("td", { colspan: "9" }, [grid])]));
      }
    });
  }

  // ---------- delete ----------
  function updateSel() {
    $("selN").textContent = String(selected.size);
    $("delSel").style.display = selected.size ? "" : "none";
    const q = $("q").value.trim().toLowerCase();
    const shown = rows.filter((r) => matches(r, q));
    $("selAll").checked = shown.length > 0 && shown.every((r) => selected.has(r.customer_id));
  }

  async function removeLogoFile(logoUrl) {
    const marker = `/object/public/${BUCKET}/`;
    const i = logoUrl.indexOf(marker);
    if (i < 0) return;
    const path = logoUrl.slice(i + marker.length).split("?")[0];
    await fetch(`${cfg().url}/storage/v1/object/${BUCKET}/${path}`, { method: "DELETE", headers: headers() });
  }

  async function deleteCustomers(list) {
    for (const r of list) { if (r.logo_url) { try { await removeLogoFile(r.logo_url); } catch (e) {} } }
    const inList = list.map((r) => '"' + String(r.customer_id).replace(/"/g, "") + '"').join(",");
    const resp = await fetch(`${cfg().url}/rest/v1/${TABLE}?customer_id=in.(${encodeURIComponent(inList)})`, {
      method: "DELETE",
      headers: headers({ Prefer: "return=representation" }),
    });
    if (!resp.ok) throw new Error(friendly(resp.status, await resp.text().catch(() => "")));
    const gone = await resp.json().catch(() => []);
    if (!Array.isArray(gone) || gone.length < list.length) {
      throw new Error(`Only ${Array.isArray(gone) ? gone.length : 0} of ${list.length} were deleted — the table policy may not allow deleting. Run supabase-setup.sql once.`);
    }
    const ids = new Set(list.map((r) => r.customer_id));
    rows = rows.filter((r) => !ids.has(r.customer_id));
    ids.forEach((id) => selected.delete(id));
  }

  async function removeWithConfirm(list) {
    if (!list.length) return;
    const what = list.length === 1 ? `customer ${list[0].customer_id} (${bareName(list[0])})` : `${list.length} customers`;
    if (!confirm(`Delete ${what}?\n\nThe record and its logo are removed from the cloud, and the extension drops them from its saved records too. This cannot be undone.`)) return;
    try {
      await deleteCustomers(list);
      msg(`Deleted ${what}.`, "ok");
    } catch (e) {
      msg(e.message, "err");
    }
    render();
  }

  // ---------- events ----------
  $("delSel").addEventListener("click", () => removeWithConfirm(rows.filter((r) => selected.has(r.customer_id))));
  $("selAll").addEventListener("change", (e) => {
    const q = $("q").value.trim().toLowerCase();
    rows.filter((r) => matches(r, q)).forEach((r) => (e.target.checked ? selected.add(r.customer_id) : selected.delete(r.customer_id)));
    render();
  });
  $("q").addEventListener("input", render);
  $("refresh").addEventListener("click", load);
  $("filePick").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !pickFor) return;
    if (!/^image\//.test(file.type)) return msg("Please choose an image file.", "err");
    const row = pickFor;
    msg(`Uploading logo for ${row.customer_id}…`, "info");
    try {
      await uploadLogo(row, file);
      msg(`Logo saved for ${row.customer_id}.`, "ok");
      render();
    } catch (err) {
      msg(err.message, "err");
    }
  });
  $("exportMissing").addEventListener("click", () => {
    const miss = rows.filter((r) => !hasLogo(r));
    if (!miss.length) return msg("Every saved customer has a logo.", "ok");
    download("customers-without-logo.csv", ["customer_id,business_name,owner_mobile", ...miss.map((r) => [r.customer_id, bareName(r), r.owner_mobile].map(csvCell).join(","))].join("\r\n"));
  });
  $("exportAll").addEventListener("click", () => {
    if (!rows.length) return;
    const cols = ["customer_id", "business_id", "business_name", "owner_mobile", "address", "services", "logo_url", "logo_status", "profile_url", "updated_at"];
    download("sulekha-customers.csv", [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n"));
  });

  $("cfgUrl").value = cfg().url;
  $("cfgKey").value = cfg().key;
  $("cfgSave").addEventListener("click", () => {
    store("sbUrl", $("cfgUrl").value.trim());
    store("sbKey", $("cfgKey").value.trim());
    load();
  });

  load();
  setInterval(load, 60000);
})();
