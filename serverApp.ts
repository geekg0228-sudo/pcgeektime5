import express from "express";

export const app = express();

app.use(express.json());

const GUERRILLA_API = "https://api.guerrillamail.com/ajax.php";
const MAIL_TM_API = "https://api.mail.tm";

// In-memory cache for mail.tm domains to prevent 429
let cachedMailTmDomains: { domains: string[]; fetchedAt: number } = {
  domains: ["web-library.net"],
  fetchedAt: 0,
};

// Helper for fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// CORS / Headers middleware
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// 1. Get available domains
app.get("/api/mail/domains", async (req, res) => {
  const guerrillaDomains = [
    "sharklasers.com",
    "guerrillamail.com",
    "guerrillamailblock.com",
    "grr.la",
    "guerrillamail.net",
    "pokemail.net",
  ];

  if (Date.now() - cachedMailTmDomains.fetchedAt > 15 * 60 * 1000) {
    try {
      const resp = await fetchWithTimeout(`${MAIL_TM_API}/domains`, {}, 4000);
      if (resp.ok) {
        const data = await resp.json();
        const active = (data["hydra:member"] || [])
          .filter((d: any) => d.isActive !== false)
          .map((d: any) => d.domain);
        if (active.length > 0) {
          cachedMailTmDomains = { domains: active, fetchedAt: Date.now() };
        }
      }
    } catch {
      // Ignore mail.tm failure & use cached/default
    }
  }

  const allDomains = Array.from(new Set([...guerrillaDomains, ...cachedMailTmDomains.domains]));
  res.json({ success: true, domains: allDomains });
});

// 2. Create new mailbox account
app.post("/api/mail/account", async (req, res) => {
  try {
    const { username, domain } = req.body || {};
    const requestedDomain = domain || "sharklasers.com";
    const customUser = username || `usr${Math.floor(100000 + Math.random() * 900000)}`;

    const isGuerrilla = [
      "sharklasers.com",
      "guerrillamail.com",
      "guerrillamailblock.com",
      "grr.la",
      "guerrillamail.net",
      "pokemail.net",
    ].includes(requestedDomain);

    if (isGuerrilla) {
      const initResp = await fetchWithTimeout(`${GUERRILLA_API}?f=get_email_address`, {}, 5000);
      if (!initResp.ok) throw new Error("Guerrilla Mail initialization failed");
      const initData = await initResp.json();
      const sidToken = initData.sid_token;

      const setResp = await fetchWithTimeout(
        `${GUERRILLA_API}?f=set_email_user&email_user=${encodeURIComponent(
          customUser
        )}&site=${encodeURIComponent(requestedDomain)}&sid_token=${encodeURIComponent(sidToken)}`,
        {},
        5000
      );
      if (!setResp.ok) throw new Error("Guerrilla Mail set_email_user failed");
      const setData = await setResp.json();

      const finalAddress = `${setData.email_addr.split("@")[0]}@${requestedDomain}`;

      return res.json({
        success: true,
        address: finalAddress,
        accountId: sidToken,
        token: `guerrilla:${sidToken}`,
        provider: "guerrilla",
      });
    } else {
      try {
        const address = `${customUser.toLowerCase()}@${requestedDomain}`;
        const password = `Pass_${Math.random().toString(36).substring(2)}${Date.now()}`;

        const accResp = await fetchWithTimeout(`${MAIL_TM_API}/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, password }),
        }, 5000);

        if (accResp.status === 429) {
          throw new Error("MAIL_TM_RATE_LIMIT");
        }

        if (!accResp.ok) {
          const errTxt = await accResp.text();
          throw new Error(`mail.tm account error: ${errTxt}`);
        }

        const account = await accResp.json();

        const tokenResp = await fetchWithTimeout(`${MAIL_TM_API}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, password }),
        }, 5000);

        if (!tokenResp.ok) throw new Error("mail.tm token failed");
        const tokenData = await tokenResp.json();

        return res.json({
          success: true,
          address,
          accountId: account.id,
          token: `mailtm:${tokenData.token}`,
          password,
          provider: "mailtm",
        });
      } catch (err: any) {
        console.warn("Mail.tm failed/rate-limited, falling back to Guerrilla Mail:", err?.message);
        const initResp = await fetchWithTimeout(`${GUERRILLA_API}?f=get_email_address`, {}, 5000);
        const initData = await initResp.json();
        const sidToken = initData.sid_token;

        const setResp = await fetchWithTimeout(
          `${GUERRILLA_API}?f=set_email_user&email_user=${encodeURIComponent(
            customUser
          )}&site=sharklasers.com&sid_token=${encodeURIComponent(sidToken)}`,
          {},
          5000
        );
        const setData = await setResp.json();
        const fallbackAddress = `${setData.email_addr.split("@")[0]}@sharklasers.com`;

        return res.json({
          success: true,
          address: fallbackAddress,
          accountId: sidToken,
          token: `guerrilla:${sidToken}`,
          provider: "guerrilla",
        });
      }
    }
  } catch (err: any) {
    console.error("Error creating account:", err?.message || err);
    res.status(500).json({ success: false, error: err?.message || "Failed to create account" });
  }
});

// 3. Get messages list
app.get("/api/mail/messages", async (req, res) => {
  try {
    const rawToken = req.headers.authorization?.replace("Bearer ", "") || "";
    if (!rawToken) {
      return res.status(401).json({ success: false, error: "Missing authorization token" });
    }

    if (rawToken.startsWith("guerrilla:")) {
      const sidToken = rawToken.replace("guerrilla:", "");
      const resp = await fetchWithTimeout(
        `${GUERRILLA_API}?f=get_email_list&offset=0&sid_token=${encodeURIComponent(sidToken)}`,
        {},
        6000
      );
      if (!resp.ok) throw new Error("Guerrilla list fetch failed");
      const data = await resp.json();
      const rawList = data.list || [];

      const filteredRaw = rawList.filter((m: any) => {
        const from = (m.mail_from || "").toLowerCase();
        const subj = (m.mail_subject || "").toLowerCase();
        return !from.includes("guerrillamail") && !subj.includes("welcome to guerrilla mail");
      });

      const messages = filteredRaw.map((m: any) => ({
        id: `g_${m.mail_id}`,
        sender: m.mail_from || "Unknown",
        senderEmail: m.mail_from || "",
        subject: m.mail_subject || "(No Subject)",
        preview: m.mail_excerpt || "",
        timestamp: m.mail_date || "Just now",
        date: new Date(Number(m.mail_timestamp || Date.now() / 1000) * 1000).toISOString(),
        isUnread: Number(m.mail_read) === 0,
      }));

      return res.json({ success: true, messages });
    } else if (rawToken.startsWith("mailtm:")) {
      const token = rawToken.replace("mailtm:", "");
      const resp = await fetchWithTimeout(`${MAIL_TM_API}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      }, 6000);

      if (resp.status === 429) {
        return res.json({ success: true, messages: [] });
      }

      if (!resp.ok) throw new Error("mail.tm list failed");
      const data = await resp.json();
      const rawList = data["hydra:member"] || [];

      const messages = rawList.map((m: any) => ({
        id: `mt_${m.id}`,
        sender: m.from?.name || m.from?.address || "Unknown",
        senderEmail: m.from?.address || "",
        subject: m.subject || "(No Subject)",
        preview: m.intro || "",
        timestamp: new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        date: m.createdAt,
        isUnread: !m.seen,
      }));

      return res.json({ success: true, messages });
    } else {
      res.status(400).json({ success: false, error: "Invalid token format" });
    }
  } catch (err: any) {
    console.error("Error fetching messages:", err?.message || err);
    res.status(500).json({ success: false, error: err?.message || "Failed to fetch messages" });
  }
});

// 4. Get message detail
app.get("/api/mail/message/:id", async (req, res) => {
  try {
    const rawToken = req.headers.authorization?.replace("Bearer ", "") || "";
    const { id } = req.params;

    if (!rawToken) {
      return res.status(401).json({ success: false, error: "Missing authorization token" });
    }

    if (id.startsWith("g_") || rawToken.startsWith("guerrilla:")) {
      const sidToken = rawToken.replace("guerrilla:", "");
      const mailId = id.replace("g_", "");

      const resp = await fetchWithTimeout(
        `${GUERRILLA_API}?f=fetch_email&email_id=${encodeURIComponent(
          mailId
        )}&sid_token=${encodeURIComponent(sidToken)}`,
        {},
        6000
      );
      if (!resp.ok) throw new Error("Guerrilla message fetch failed");
      const msg = await resp.json();

      const fullText = `${msg.mail_subject || ""} ${msg.mail_excerpt || ""} ${msg.mail_body || ""}`;
      const otpMatch = fullText.match(/\b(\d{4,8}|\d{3}[-\s]\d{3})\b/);
      const otpCode = otpMatch ? otpMatch[1] : undefined;

      const bodyHtml = msg.mail_body || `<pre>${msg.mail_excerpt || ""}</pre>`;

      return res.json({
        success: true,
        message: {
          id: `g_${msg.mail_id}`,
          sender: msg.mail_from || "Unknown",
          senderEmail: msg.mail_from || "",
          subject: msg.mail_subject || "(No Subject)",
          preview: msg.mail_excerpt || "",
          bodyHtml,
          bodyText: msg.mail_excerpt || "",
          timestamp: msg.mail_date || "Just now",
          date: new Date(Number(msg.mail_timestamp || Date.now() / 1000) * 1000).toISOString(),
          isUnread: false,
          otpCode,
        },
      });
    } else if (id.startsWith("mt_") || rawToken.startsWith("mailtm:")) {
      const token = rawToken.replace("mailtm:", "");
      const mailId = id.replace("mt_", "");

      const resp = await fetchWithTimeout(`${MAIL_TM_API}/messages/${mailId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }, 6000);

      if (!resp.ok) throw new Error("mail.tm message fetch failed");
      const msg = await resp.json();

      const fullText = `${msg.subject || ""} ${msg.intro || ""} ${msg.text || ""}`;
      const otpMatch = fullText.match(/\b(\d{4,8}|\d{3}[-\s]\d{3})\b/);
      const otpCode = otpMatch ? otpMatch[1] : undefined;

      let bodyHtml = "";
      if (Array.isArray(msg.html) && msg.html.length > 0) {
        bodyHtml = msg.html.join("");
      } else if (typeof msg.html === "string") {
        bodyHtml = msg.html;
      } else if (msg.text) {
        bodyHtml = `<div style="white-space: pre-wrap; font-family: monospace;">${msg.text}</div>`;
      }

      return res.json({
        success: true,
        message: {
          id: `mt_${msg.id}`,
          sender: msg.from?.name || msg.from?.address || "Unknown",
          senderEmail: msg.from?.address || "",
          subject: msg.subject || "(No Subject)",
          preview: msg.intro || "",
          bodyHtml,
          bodyText: msg.text || "",
          timestamp: new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          date: msg.createdAt,
          isUnread: false,
          otpCode,
        },
      });
    }
  } catch (err: any) {
    console.error("Error fetching message detail:", err?.message || err);
    res.status(500).json({ success: false, error: err?.message || "Failed to fetch message" });
  }
});

// 5. Delete message
app.delete("/api/mail/message/:id", async (req, res) => {
  try {
    const rawToken = req.headers.authorization?.replace("Bearer ", "") || "";
    const { id } = req.params;

    if (!rawToken) {
      return res.status(401).json({ success: false, error: "Missing authorization token" });
    }

    if (id.startsWith("g_") || rawToken.startsWith("guerrilla:")) {
      const sidToken = rawToken.replace("guerrilla:", "");
      const mailId = id.replace("g_", "");

      await fetchWithTimeout(
        `${GUERRILLA_API}?f=del_email&email_ids[]=${encodeURIComponent(
          mailId
        )}&sid_token=${encodeURIComponent(sidToken)}`,
        {},
        5000
      );
      return res.json({ success: true });
    } else if (id.startsWith("mt_") || rawToken.startsWith("mailtm:")) {
      const token = rawToken.replace("mailtm:", "");
      const mailId = id.replace("mt_", "");

      await fetchWithTimeout(`${MAIL_TM_API}/messages/${mailId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }, 5000);
      return res.json({ success: true });
    }
  } catch (err: any) {
    console.error("Error deleting message:", err?.message || err);
    res.status(500).json({ success: false, error: err?.message || "Failed to delete message" });
  }
});
