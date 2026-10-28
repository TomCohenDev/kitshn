// The live list of public apps (K-1116). kitshn lists only cards that anyone may open now.
const SOURCE = "https://kit.yarden-zamir.com/public/cards.json";
const KIND_NAMES = {
  "site.static": ["static site", "ok"],
  "site.worker": ["Worker app", "blue"],
  "site.compose": ["Compose app", "orange"],
};

const list = document.querySelector("#apps");
const status = document.querySelector("#apps-status");

function item(card) {
  const [kindName, color] = KIND_NAMES[card.kind] ?? [card.kind, ""];
  const li = document.createElement("li");
  const link = document.createElement("a");
  link.className = "card";
  link.href = `https://${card.address}`;
  const icon = document.createElement("img");
  icon.className = "icon";
  icon.alt = "";
  icon.src = card.icon ?? "/favicon.svg";
  const text = document.createElement("span");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = card.name;
  const address = document.createElement("span");
  address.className = "address";
  address.textContent = card.address;
  text.append(name, address);
  const sticker = document.createElement("span");
  sticker.className = `sticker ${color}`;
  sticker.textContent = kindName;
  link.append(icon, text, sticker);
  li.append(link);
  return li;
}

try {
  const answer = await fetch(SOURCE);
  if (!answer.ok) throw new Error(`kitshn answered ${answer.status}`);
  const { cards } = await answer.json();
  if (!Array.isArray(cards)) throw new Error("the answer has no list of cards");
  list.replaceChildren(...cards.map(item));
  status.textContent =
    cards.length === 0
      ? "No public apps right now."
      : `${cards.length} public apps, straight from kitshn. The list changes when a card enters or leaves the Everyone circle.`;
} catch (error) {
  status.textContent = `The list did not load (${error.message}). The apps run on, and the list comes back when kitshn answers.`;
}
