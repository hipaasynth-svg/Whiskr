# Whiskr

**whiskr.lol** is a small cat business with three parts:

- **A free monthly cat photo contest.** Anyone can enter their cat free,
  and anyone can vote, once per cat. When the month's round closes, the cat
  with the most votes is Cat of the Month and wins an original 11x16
  acrylic portrait hand-painted by artist Cody Carlson. No purchase is
  necessary to enter or win. Full mechanics are in the
  [official rules](https://whiskr.lol/rules.html).
- **A custom print shop.** Upload a photo of your cat and order it on a
  mug, canvas, framed print, poster, phone case, pillow, magnet,
  sweatshirt and more. Everything is printed to order and shipped by
  Printful.
- **Original commissions.** Book an original acrylic painting of your cat
  directly from Cody Carlson, paid as a 40% deposit and a balance on
  completion.

There's also a [blog](https://whiskr.lol/blog) of practical,
source-cited writing about living with cats.

## Where things are

- **[`cat-calendar-app/`](cat-calendar-app/)** is the entire product: a
  Node/Express app deployed on Vercel with Postgres, Vercel Blob and Vercel
  Cron. Its [README](cat-calendar-app/README.md) covers setup, deployment
  and day-to-day operation. (The folder name is historical; the site no
  longer sells calendars. Renaming it would mean changing the Vercel
  project's root directory at the same time.)
- **[`CLAUDE.md`](CLAUDE.md)** holds the working rules for anyone, human
  or AI, changing this code: start from `main`, the pricing floor, and the
  two legal rules below.
- **[`docs/audit-assembly.md`](docs/audit-assembly.md)** is the running
  decision log. Read the most recent sections; older ones describe
  decisions that have since been reversed.

## Two rules that never bend

1. **Reviews are real or absent.** A review can only be created through a
   signed link sent after a real paid order, and it stays hidden until it's
   approved. There is no seed data and no admin "add review" path.
   Fabricated reviews are illegal under 16 CFR Part 465.
2. **The site says what the code does.** Votes are real database rows, rate
   limited and fraud-checked, and the winner is whoever has the most votes.
   If the contest mechanics change, the copy, the rules page and the emails
   change in the same commit.
