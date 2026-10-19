// The real use: fill a form with generated rows. Needs a browser (`npx playwright install chromium`), so it runs only
// when ROWSMITH_PW_BROWSER=1; the offline smoke runs data.spec.ts only.
import { expect, test } from "./rowsmith.fixture";

test.skip(process.env.ROWSMITH_PW_BROWSER !== "1", "needs a browser: set ROWSMITH_PW_BROWSER=1 after npx playwright install chromium");

test("a signup form accepts generated customers", async ({ page, rowsmith }) => {
  const { rows } = await rowsmith.generate({
    rows: 3,
    seed: 7,
    columns: [
      { name: "name", type: "full_name" },
      { name: "email", type: "email" },
    ],
  });
  await page.setContent(`
    <form id="signup"><input name="name"><input name="email" type="email"><button>Sign up</button></form>
    <ul id="done"></ul>
    <script>
      document.getElementById("signup").addEventListener("submit", (e) => {
        e.preventDefault();
        const li = document.createElement("li");
        li.textContent = e.target.email.value;
        document.getElementById("done").append(li);
        e.target.reset();
      });
    </script>`);
  for (const row of rows) {
    await page.fill("input[name=name]", String(row.name));
    await page.fill("input[name=email]", String(row.email));
    await page.click("button");
  }
  await expect(page.locator("#done li")).toHaveCount(rows.length);
});
