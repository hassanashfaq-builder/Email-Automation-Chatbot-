const VARIABLE_RE = /\[([^\]]+)\]/g;

// Maps recognized [Bracket] labels (case-insensitive) to guest fields.
const FIELD_ALIASES = {
  'name': 'name',
  'full name': 'name',
  'fullname': 'name',
  'guest name': 'name',
  'background': 'background',
  'about': 'background',
  'bio': 'background',
  'topic': 'topic',
  'email': 'email',
};

function detectVariables(text) {
  const found = new Set();
  let m;
  const re = new RegExp(VARIABLE_RE);
  while ((m = re.exec(text || ''))) found.add(m[1].trim());
  return [...found].map((label) => ({
    label,
    recognized: !!FIELD_ALIASES[label.toLowerCase()],
  }));
}

function fillTemplate(text, guest) {
  return (text || '').replace(VARIABLE_RE, (full, label) => {
    const field = FIELD_ALIASES[label.trim().toLowerCase()];
    return field ? (guest[field] || '') : full;
  });
}

const DEFAULT_TEMPLATE = {
  name: 'Guest Invitation Email',
  subject: 'Invitation to Join Kianistan Podcast',
  body: `Dear [Full Name],

I hope you are doing well. My name is Hassan Ashfaq, and I am the producer of the Kianistan Podcast, a platform dedicated to thoughtful, in-depth discussions on geopolitics, international law, and global affairs with leading experts around the world.

Given your extensive background as [Background], we would be deeply honored to have you join us for a conversation and share your expertise with our audience.

Our episodes are recorded remotely, with fully flexible scheduling. Each conversation runs approximately 45–60 minutes and is conducted in an open, respectful, and analytically rigorous format. You may explore our past episodes here:
👉 https://www.youtube.com/@kianistan

I would be delighted to coordinate a suitable time for the discussion and share further details.

Warm regards,
Hassan Ashfaq
Producer — Kianistan Podcast
🎥 https://www.youtube.com/@kianistan
📧 tafhimkiani@gmail.com
🌐 http://www.kianistan.com/`,
};

module.exports = { detectVariables, fillTemplate, FIELD_ALIASES, DEFAULT_TEMPLATE };
