// A public read of saved fictional city activity. No identity lookup, tools or progress mutations.
export function cityLines(link) {
  const view=link.nativeCity?.overview();
  if(!view?.enabled)return ['Native city life is disabled on this server. Harr remains available.'];
  return ['NemoWorld city: peaceful scripted native residents; human visitors are guests.',
    `${view.citizens.length} citizens; ${view.marriages.length} preapproved fictional marriages; ${view.births.length} children.`,
    `${view.reports.length} saved simulation reports; ${view.harvests.length} virtual harvests; ${view.attendance.length} school visits.`,
    'These are game simulation outputs, not independent research reviews or real-world impact.',
    ...view.citizens.slice(0,16).map(c=>`${c.name}: ${c.stage}, ${c.role}.`),
    'Visit /city in your local NemoWorld browser. Link your human character, then choose Visit the city in Veloren.',
    'The city is north of Harr. Return to Harr is also available on /city. No currency is awarded for city life.'];
}
