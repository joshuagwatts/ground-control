import test from "node:test";
import assert from "node:assert/strict";

test("education: items normalize to title/body pairs", async () => {
  const { educationItems, ROOF_HAIL_EDUCATION } = await import("../www/homeowner/product.js");
  const items = educationItems();
  assert.equal(items.length, 6);
  for (const it of items) {
    assert.ok(it.title.trim(), "summary required");
    assert.ok(it.body.trim(), "detail required");
  }
  assert.match(ROOF_HAIL_EDUCATION.blurb, /tap/i);
});

test("education: legacy bullets shape still renders", async () => {
  const { educationItems } = await import("../www/homeowner/product.js");
  const items = educationItems({ title: "Old", bullets: ["one", "two"] });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "one");
  assert.equal(items[0].body, "");
});

test("accordion: collapsed by default, expanded on request", async () => {
  const { accordionItemsHtml } = await import("../www/homeowner/product.js");
  const items = [
    { title: "Short", body: "Long <b>detail</b>" },
    { title: "No detail", body: "" },
  ];
  const collapsed = accordionItemsHtml(items);
  assert.ok(collapsed.startsWith('<div class="hg-acc-item">'), "items with detail collapse by default");
  assert.ok(collapsed.includes('aria-expanded="false"'));
  assert.ok(!collapsed.includes("<b>detail</b>"), "body is escaped");
  // Item without a body renders open so nothing is hidden.
  assert.ok(collapsed.includes('class="hg-acc-item open"'));
  assert.ok(collapsed.includes('aria-expanded="true"'));
  const expanded = accordionItemsHtml(items, { expanded: true });
  assert.ok(expanded.includes('class="hg-acc-item open"'));
  assert.ok(expanded.includes('aria-expanded="true"'));
});

test("education accordion wraps items for the report", async () => {
  const { educationAccordionHtml } = await import("../www/homeowner/product.js");
  const html = educationAccordionHtml();
  assert.ok(html.includes('data-accordion="education"'));
  assert.ok(html.includes("hg-acc-btn"));
  assert.equal(educationAccordionHtml({}), "");
});

test("faq: two groups, every question answered", async () => {
  const { HOMEOWNER_FAQ, faqGroups, homeownerFaqHtml } = await import("../www/homeowner/product.js");
  assert.equal(HOMEOWNER_FAQ.groups.length, 2);
  const groups = faqGroups();
  assert.equal(groups.length, 2);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, 12);
  for (const g of groups) {
    assert.ok(g.label.trim());
    for (const it of g.items) {
      assert.ok(it.title.trim().length > 10, "question should read like a question");
      assert.ok(it.body.trim().length > 20, "answer should actually answer");
    }
  }
  const html = homeownerFaqHtml();
  assert.ok(html.includes("Roofing basics"));
  assert.ok(html.includes("Insurance basics"));
  assert.ok(html.includes("deductible"));
});

test("expandAccordionsHtml forces every item open", async () => {
  const { expandAccordionsHtml, accordionItemsHtml } = await import("../www/homeowner/product.js");
  const html = accordionItemsHtml([{ title: "Q", body: "A" }]);
  const expanded = expandAccordionsHtml(html);
  assert.ok(expanded.includes('class="hg-acc-item open"'));
  assert.ok(expanded.includes('aria-expanded="true"'));
  assert.ok(!expanded.includes('aria-expanded="false"'));
});
