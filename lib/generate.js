const TEMPLATE_EXAMPLE = `Dear Mr. Alfred-Maurice de Zayas,
I hope you are doing well. My name is Hassan Ashfaq, and I am the producer of the Kianistan Podcast, a platform dedicated to thoughtful, in-depth discussions on geopolitics, international law, and global affairs with leading experts around the world.
We are currently preparing an expert interview on:
the escalating U.S.–Venezuela tensions, the legal and humanitarian implications of sanctions, and the potential consequences of any military confrontation.
Given your extensive background as the UN Independent Expert on the Promotion of a Democratic and Equitable International Order, your on-the-ground fact-finding visit to Venezuela, and your outspoken criticism of unilateral sanctions and "economic warfare," we would be deeply honored to have you share your expertise.
Your experience as a former senior lawyer at the UN Office of the High Commissioner for Human Rights, Secretary of the Human Rights Committee, and Chief of the Petitions Section — along with your decades of scholarly work, books, and advocacy for international legality — would provide an authoritative and essential perspective for our audience.
Our episodes are recorded remotely, with fully flexible scheduling. Each conversation runs approximately 45–60 minutes and is conducted in an open, respectful, and analytically rigorous format.
You may explore our past episodes here:
👉 https://www.youtube.com/@kianistan
If this topic aligns with your interests, I would be delighted to coordinate a suitable time for the discussion and share the proposed thematic outline.
Warm regards,
Hassan Ashfaq
Producer — Kianistan Podcast
🎥 https://www.youtube.com/@kianistan
📧 tafhimkiani@gmail.com
🌐 http://www.kianistan.com/`;

async function generateInvitation(guest, config) {
  const { geminiApiKey, geminiModel } = config;
  if (!geminiApiKey || geminiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('Gemini API key not set in config.json');
  }

  const systemPrompt = `You write personalized podcast guest invitation emails for Hassan Ashfaq, producer of the Kianistan Podcast.

Follow the EXACT structure, tone, paragraph order, and sign-off of the example template below. Keep the same greeting style ("Dear [Title] [Name],"), the same flexible-scheduling paragraph, the same links, and the same warm, formal, respectful tone. Only change the content that is specific to the guest: their name, their background/credentials paragraph, and the topic paragraph, weaving in the details naturally the way the template does.

Output ONLY the email body text. No subject line, no preamble, no markdown formatting, no explanation — just the final email ready to send.

TEMPLATE EXAMPLE:
${TEMPLATE_EXAMPLE}`;

  const userPrompt = `Write the invitation email for this guest:

Name: ${guest.name}
Background: ${guest.background}
${guest.topic ? `Suggested topic: ${guest.topic}` : ''}`;

  const model = geminiModel || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: 4000,
    },
  });

  // A 429 response tells us exactly how long until its per-minute quota
  // resets (e.g. "...Please retry in 35.87s"). Waiting a token 1-2s and
  // giving up, like a generic backoff would, is pointless against that —
  // so parse and actually honor it (capped so a single guest can't hang
  // past a serverless function's execution time budget).
  function parseRetryDelaySeconds(errText) {
    try {
      const details = JSON.parse(errText).error?.details || [];
      const retryInfo = details.find(d => d['@type']?.includes('RetryInfo'));
      const m = /^(\d+(?:\.\d+)?)s$/.exec(retryInfo?.retryDelay || '');
      if (m) return parseFloat(m[1]);
    } catch (_) {}
    const m = /retry in (\d+(?:\.\d+)?)s/i.exec(errText);
    return m ? parseFloat(m[1]) : null;
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey,
      },
      body,
    });

    if (response.ok) {
      const data = await response.json();
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map(p => p.text || '').join('').trim();
      if (!text) throw new Error('No text returned from Gemini API');
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new Error('Gemini response was cut off (hit max token limit) — try again or shorten the template');
      }
      return text;
    }

    const errText = await response.text();
    let message = errText;
    try { message = JSON.parse(errText).error?.message || errText; } catch (_) {}

    // 429 (rate limited) and 503 (temporarily overloaded) are transient —
    // worth a retry instead of failing the guest outright.
    const retryable = response.status === 429 || response.status === 503;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`Gemini API error (${response.status}): ${message}`);
    }

    const suggestedDelay = response.status === 429 ? parseRetryDelaySeconds(errText) : null;
    const waitSeconds = suggestedDelay != null ? Math.min(suggestedDelay + 1, 25) : attempt;
    await new Promise(r => setTimeout(r, waitSeconds * 1000));
  }
}

module.exports = { generateInvitation };
