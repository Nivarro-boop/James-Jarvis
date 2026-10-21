export type WorkflowPreset = {
  id: string
  title: string
  description: string
  prompt: string
}

/** Eigene, unverbindliche Formulierungshilfen; eine Auswahl startet keinen Auftrag. */
export const workflowPresets: readonly WorkflowPreset[] = [
  {
    id: 'day-overview',
    title: 'Tagesüberblick',
    description: 'Wichtiges, Termine und offene Punkte für heute sortieren.',
    prompt: 'Gib mir einen kompakten Überblick für heute: wichtige Termine, offene Aufgaben und mögliche Engpässe. Trenne bestätigte Informationen von Vermutungen und nenne die Quellen, falls du auf verbundene Zugänge zugreifst.'
  },
  {
    id: 'weekly-priorities',
    title: 'Wochenprioritäten',
    description: 'Aus Aufgaben eine realistische Reihenfolge machen.',
    prompt: 'Hilf mir, meine Prioritäten für diese Woche zu ordnen. Berücksichtige Fristen, Aufwand und Abhängigkeiten, schlage höchstens drei Schwerpunkte vor und markiere, was noch geklärt werden muss.'
  },
  {
    id: 'meeting-follow-up',
    title: 'Gespräch nachbereiten',
    description: 'Ergebnisse, Zusagen und nächste Schritte festhalten.',
    prompt: 'Bereite dieses Gespräch nach: fasse die wesentlichen Punkte zusammen, liste Entscheidungen und Zusagen getrennt auf und formuliere konkrete nächste Schritte mit Verantwortlichen und Fristen, sofern sie genannt wurden. Erfinde keine fehlenden Angaben.'
  },
  {
    id: 'reply-draft',
    title: 'Antwortentwurf',
    description: 'Eine passende Antwort zur Prüfung vorbereiten.',
    prompt: 'Erstelle einen freundlichen, klaren Antwortentwurf auf die Nachricht, die ich dir nenne oder bereitstelle. Beantworte nur, was sich aus dem Kontext sicher ableiten lässt, und kennzeichne offene Fragen. Sende nichts ab.'
  },
  {
    id: 'project-status',
    title: 'Projektstatus',
    description: 'Fortschritt, Risiken und nächste Entscheidungen bündeln.',
    prompt: 'Erstelle einen kurzen Projektstatus mit Fortschritt, erledigten Punkten, offenen Aufgaben, Risiken und anstehenden Entscheidungen. Unterscheide belegte Fakten von Einschätzungen und weise auf fehlende Informationen hin.'
  },
  {
    id: 'focus-plan',
    title: 'Fokusplan',
    description: 'Einen überschaubaren Arbeitsblock ohne Ablenkung planen.',
    prompt: 'Hilf mir, einen realistischen Fokusplan für meinen nächsten Arbeitsblock zu erstellen. Schlage ein konkretes Ziel, kleine Arbeitsschritte und kurze Pausen vor; plane keine Termine und ändere keine Aufgaben oder Einstellungen.'
  }
]
