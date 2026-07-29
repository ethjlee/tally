type PageOptions = {
  title: string;
  heading: string;
  intro: string;
  body: string;
  script: string;
};

export function securePage(options: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#14171c">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <title>${options.title}</title>
  <link rel="icon" href="/icons/tally.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/auth.css">
  <script src="${options.script}" defer></script>
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card" aria-labelledby="page-title">
      <div class="brand" aria-label="Tally">
        <img src="/icons/tally.svg" width="40" height="40" alt="">
        <span>Tally</span>
      </div>
      <h1 id="page-title">${options.heading}</h1>
      <p class="intro">${options.intro}</p>
      ${options.body}
    </section>
  </main>
</body>
</html>`;
}

export function pageResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}
