// Today's suggested social post, for the "Post today" section of the daily
// digest email. Pure: the caller passes in real numbers from the database and
// gets back ready-to-paste copy for Instagram and a Google Business Profile.
//
// The same rule as the site copy applies here (see CLAUDE.md): every claim
// must match the mechanism that actually runs. So:
//   - the winner is "the top vote-getter", never "most likes" — voting only
//     happens on whiskr.lol, never in a social app;
//   - no prize dollar value in a caption; that belongs in the rules;
//   - no entry count until it clears the same threshold the homepage uses;
//   - an entrant's photo is only suggested because rules.html#photo-rights
//     grants use on Whiskr's own social accounts to promote the contest;
//   - nothing here invents a photo — a post that needs one says whose.

const ENTRY_COUNT_DISPLAY_THRESHOLD = 25; // same as getContestStatus() in server.js

const HASHTAGS = '#catsofinstagram #catcontest #catphoto #catlovers #petportrait #catart #instacat #catmom #catdad';

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Day number since the epoch, so the rotation advances once per day and is the
// same for every call made on that day.
function dayIndex(date) {
  return Math.floor(date.getTime() / (24 * 60 * 60 * 1000));
}

/**
 * @param {object} p
 * @param {Date}   p.now
 * @param {string} p.baseUrl            e.g. https://whiskr.lol
 * @param {number|null} p.daysLeft      days until the open round closes, null if none open
 * @param {number} p.entryCount         non-disqualified entries in the open round
 * @param {{cat_name:string, photo_path:string}|null} p.lastWinner
 * @param {{cat_name:string, photo_path:string}|null} p.spotlightEntry  a random entry this round
 * @param {number} p.commissionFromUsd  cheapest published commission price
 */
function todaysPost(p) {
  const site = p.baseUrl.replace(/^https?:\/\//, '');
  const abs = (path) => (path && path.startsWith('http') ? path : `${p.baseUrl}${path || ''}`);
  const launchImage = `${p.baseUrl}/social/whiskr-launch.png`;
  const launchAlt =
    'Graphic on a dark navy background with an orange cartoon cat face with long whiskers. Text reads: ' +
    '"WHISKR.LOL — Free cat photo contest. Top vote-getter each month wins an original painting of their cat. ' +
    `Enter free at ${site} · US 18+."`;
  const entriesLine =
    p.entryCount >= ENTRY_COUNT_DISPLAY_THRESHOLD ? `${p.entryCount} cats are already in. ` : '';

  const posts = [];

  // Closing-time posts take the day outright: they are the ones that move entries.
  if (p.daysLeft !== null && p.daysLeft <= 1) {
    posts.push({
      theme: 'Last call',
      image: launchImage,
      imageNote: 'Use the launch graphic.',
      altText: launchAlt,
      caption: `Last call ⏰ This month's contest closes ${p.daysLeft === 0 ? 'today' : 'tomorrow'}.\n\n${entriesLine}Get your cat in and send the link to everyone who'd vote for them. The top vote-getter wins an original painting of their cat by Cody Carlson.\n\nFree · US 18+\n🔗 Link in bio: ${site}`,
      google: `Last call: this month's free cat photo contest closes ${p.daysLeft === 0 ? 'today' : 'tomorrow'}. The top vote-getter wins an original hand-painted portrait of their cat by artist Cody Carlson. Free to enter, US residents 18+.`,
    });
  } else if (p.daysLeft !== null && p.daysLeft <= 7) {
    posts.push({
      theme: 'Countdown',
      image: launchImage,
      imageNote: 'Use the launch graphic.',
      altText: launchAlt,
      caption: `${plural(p.daysLeft, 'day', 'days')} left ⏳\n\n${entriesLine}There's still time to enter your cat and rally your votes. This month's top vote-getter wins an original painting of their cat — hand-painted, not a print, not AI.\n\nFree · US 18+\n🔗 Link in bio: ${site}`,
      google: `${plural(p.daysLeft, 'day', 'days')} left in this month's free cat photo contest. Enter your cat, share the link for votes, and the top vote-getter wins an original painting of their cat by artist Cody Carlson. US residents 18+.`,
    });
  } else {
    // Ordinary days: rotate through the themes that are true right now.
    const rotation = [
      {
        theme: 'How it works',
        image: launchImage,
        imageNote: 'Use the launch graphic.',
        altText: launchAlt,
        caption: `Whiskr is a free cat photo contest, every month 🐾\n\n1. Enter your cat at ${site}\n2. Share your link so friends and family vote\n3. The top vote-getter wins an original painting of their cat by artist Cody Carlson\n\nNot a print. Not AI. Free · US 18+\n🔗 Link in bio`,
        google: `Whiskr is a free monthly cat photo contest. Enter your cat, share your link for votes, and each month's top vote-getter wins an original hand-painted portrait of their cat by artist Cody Carlson. US residents 18+.`,
      },
      {
        theme: 'The prize',
        image: null,
        imageNote: "Use your own photo or short clip of Cody painting, or one of his finished paintings. Don't use a stock or AI image.",
        altText: 'Artist Cody Carlson painting an acrylic portrait. [Edit to describe what is actually in your photo.]',
        caption: `This is what's on the line 🎨\n\nA real, hand-painted acrylic original of YOUR cat, painted by artist Cody Carlson. Not a print. Not AI.\n\nEnter free — this month's top vote-getter wins.\n🔗 Link in bio: ${site}`,
        google: `Every month, the top vote-getter in Whiskr's free cat photo contest wins a real, hand-painted acrylic portrait of their cat by artist Cody Carlson. Not a print, not AI. Enter free, US residents 18+.`,
      },
      {
        theme: 'Ask a question',
        image: launchImage,
        imageNote: 'Use the launch graphic.',
        altText: launchAlt,
        caption: `What's the most ridiculous thing your cat has ever done? 👇\n\nBest stories get a reply from us. Then go enter them — it's free, and the top vote-getter each month wins an original painting of their cat.\n\n🔗 Link in bio: ${site}`,
        google: `Got a cat with a story? Enter them in Whiskr's free monthly cat photo contest — the top vote-getter wins an original hand-painted portrait by artist Cody Carlson. US residents 18+.`,
      },
      {
        theme: 'Commission an original',
        image: null,
        imageNote: "Use a photo of one of Cody's finished paintings.",
        altText: 'A finished acrylic painting by Cody Carlson. [Edit to describe the painting in your photo.]',
        caption: `Don't want to wait for the contest? 🎨\n\nCommission your own original of your cat from artist Cody Carlson — 11x16 from $${p.commissionFromUsd}. A 40% deposit books your spot.\n\n🔗 Link in bio: ${site}/commission`,
        google: `Commission a hand-painted acrylic portrait of your cat from artist Cody Carlson. 11x16 from $${p.commissionFromUsd}; a 40% deposit books your spot.`,
        googleUrl: `${p.baseUrl}/commission`,
      },
    ];

    if (p.spotlightEntry) {
      const name = p.spotlightEntry.cat_name;
      rotation.push({
        theme: 'Entry spotlight',
        image: abs(p.spotlightEntry.photo_path),
        imageNote: `Use ${name}'s entry photo (link above). Entrants agreed to this in the rules' photo-rights section.`,
        altText: `Contest entry photo of a cat named ${name}. [Edit to describe the cat in the photo.]`,
        caption: `Meet ${name} 😻 one of this month's Whiskr entries.\n\nWant your cat up here? Enter free — this month's top vote-getter wins an original painting of their cat.\n\n🔗 Link in bio: ${site}`,
        google: `Meet ${name}, one of this month's entries in Whiskr's free cat photo contest. The top vote-getter wins an original hand-painted portrait by artist Cody Carlson.`,
      });
    }

    if (p.lastWinner) {
      const name = p.lastWinner.cat_name;
      rotation.push({
        theme: 'Past winner',
        image: abs(p.lastWinner.photo_path),
        imageNote: `Use ${name}'s photo, or the finished painting once it exists.`,
        altText: `${name}, Whiskr's most recent Cat of the Month. [Edit to describe the photo.]`,
        caption: `Our most recent Cat of the Month: ${name} 🏆\n\nChosen by real public vote, and winning an original painting by artist Cody Carlson. Your cat could be next — entry is free.\n\n🔗 Link in bio: ${site}`,
        google: `Congratulations to ${name}, Whiskr's most recent Cat of the Month, chosen by public vote. Enter your cat free for a chance to win an original hand-painted portrait.`,
      });
    }

    posts.push(rotation[dayIndex(p.now) % rotation.length]);
  }

  const post = posts[0];
  // Facebook links in a post are clickable, so the "link in bio" line becomes
  // the real URL, and a long hashtag block reads as spam there — keep two.
  const facebookText = post.caption
    .replace(/🔗 Link in bio: (\S+)/, (m, url) => `👉 https://${url}`)
    .replace(/🔗 Link in bio$/m, `👉 ${p.baseUrl}`);
  return {
    theme: post.theme,
    image: post.image,
    imageNote: post.imageNote,
    altText: post.altText,
    instagramCaption: `${post.caption}\n\n${HASHTAGS}`,
    facebookText: `${facebookText}\n\n#catcontest #catsofinstagram`,
    googleText: post.google,
    googleUrl: post.googleUrl || p.baseUrl,
  };
}

// Plain-text block for the digest email.
function formatForEmail(post) {
  return [
    `Post today: ${post.theme}`,
    `Image: ${post.image || '(your own photo — see note)'}`,
    `Note: ${post.imageNote}`,
    '',
    'INSTAGRAM caption:',
    post.instagramCaption,
    '',
    'Alt text (Advanced settings → Accessibility):',
    post.altText,
    '',
    'FACEBOOK post (same image and alt text):',
    post.facebookText,
    '',
    'GOOGLE Business Profile (Add update, button "Learn more"):',
    post.googleText,
    `Link: ${post.googleUrl}`,
  ];
}

module.exports = { todaysPost, formatForEmail, ENTRY_COUNT_DISPLAY_THRESHOLD };
