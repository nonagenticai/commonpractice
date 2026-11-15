// src/blocks/seeded-port-labels.ts — the display labels for every input/output of the seeded GLOBAL
// blocks, in all 8 locales. Written to `content_translations` (entity_type `block_port`) by
// db/seed-block-port-labels.ts, INSERT-IF-MISSING only; read back by blocks/port-labels.ts.
//
// The port KEY (`force_ocr`) is a wire identifier — edges, node config and run traces are keyed on
// it — so it never changes. These are only the words a reader sees next to the port.
//
// Tuple order is SUPPORTED_LOCALES: en, nl, pl, fr, es, de, ar, he. Copy rules: docs/style-guide.md
// (short, sentence case, no jargon; nl is native business Dutch). Terms follow the block names in
// migration 0073 (nl "claim"/"polis", de "Schaden"/"Police", fr "réclamation"/"police").
//
// tests/block-port-labels.test.ts asserts that every port of every seeded global block has a full
// tuple here, so a block or port added to a seeder without labels reds CI.

/** en, nl, pl, fr, es, de, ar, he — the order of SUPPORTED_LOCALES. */
export type PortLabelTuple = readonly [string, string, string, string, string, string, string, string];

export interface BlockPortLabels {
  inputs: Record<string, PortLabelTuple>;
  outputs: Record<string, PortLabelTuple>;
}

const TEXT: PortLabelTuple = ['Text', 'Tekst', 'Tekst', 'Texte', 'Texto', 'Text', 'النص', 'טקסט'];
const ROWS: PortLabelTuple = ['Rows', 'Rijen', 'Wiersze', 'Lignes', 'Filas', 'Zeilen', 'الصفوف', 'שורות'];
const ROW_COUNT: PortLabelTuple = [
  'Number of rows', 'Aantal rijen', 'Liczba wierszy', 'Nombre de lignes', 'Número de filas',
  'Anzahl Zeilen', 'عدد الصفوف', 'מספר שורות',
];
const DATASET: PortLabelTuple = [
  'Dataset', 'Dataset', 'Zbiór danych', 'Jeu de données', 'Conjunto de datos', 'Datensatz',
  'مجموعة البيانات', 'מערך נתונים',
];
const TITLE: PortLabelTuple = ['Title', 'Titel', 'Tytuł', 'Titre', 'Título', 'Titel', 'العنوان', 'כותרת'];
const COLUMNS: PortLabelTuple = ['Columns', 'Kolommen', 'Kolumny', 'Colonnes', 'Columnas', 'Spalten', 'الأعمدة', 'עמודות'];
const CONFIDENCE: PortLabelTuple = [
  'Confidence', 'Zekerheid', 'Pewność', 'Confiance', 'Confianza', 'Konfidenz', 'درجة الثقة', 'רמת ביטחון',
];
const REASONING: PortLabelTuple = [
  'Reasoning', 'Onderbouwing', 'Uzasadnienie', 'Justification', 'Justificación', 'Begründung',
  'التعليل', 'נימוק',
];
const DECISION: PortLabelTuple = ['Decision', 'Beslissing', 'Decyzja', 'Décision', 'Decisión', 'Entscheidung', 'القرار', 'החלטה'];
const AMOUNT: PortLabelTuple = ['Amount', 'Bedrag', 'Kwota', 'Montant', 'Importe', 'Betrag', 'المبلغ', 'סכום'];
const STATUS: PortLabelTuple = ['Status', 'Status', 'Status', 'Statut', 'Estado', 'Status', 'الحالة', 'סטטוס'];
const CLAIM_ID: PortLabelTuple = [
  'Claim number', 'Claimnummer', 'Numer roszczenia', 'Numéro de réclamation', 'Número de reclamación',
  'Schadennummer', 'رقم المطالبة', 'מספר תביעה',
];
const POLICY_NO: PortLabelTuple = [
  'Policy number', 'Polisnummer', 'Numer polisy', 'Numéro de police', 'Número de póliza',
  'Policennummer', 'رقم وثيقة التأمين', 'מספר פוליסה',
];
const CUSTOMER_ID: PortLabelTuple = [
  'Customer number', 'Klantnummer', 'Numer klienta', 'Numéro client', 'Número de cliente',
  'Kundennummer', 'رقم العميل', 'מספר לקוח',
];
const FIELD: PortLabelTuple = ['Field', 'Veld', 'Pole', 'Champ', 'Campo', 'Feld', 'الحقل', 'שדה'];
const RESULT: PortLabelTuple = ['Result', 'Resultaat', 'Wynik', 'Résultat', 'Resultado', 'Ergebnis', 'النتيجة', 'תוצאה'];

/** The data-block shape shared by load-dataset and the ontology-derived example-*-data blocks. */
const DATA_IN = { source: DATASET };
const DATA_OUT = { rows: ROWS, count: ROW_COUNT };

export const SEEDED_PORT_LABELS: Readonly<Record<string, BlockPortLabels>> = {
  'ai-summarize': {
    inputs: {
      text: TEXT,
      max_lines: [
        'Maximum lines', 'Maximaal aantal regels', 'Maksymalna liczba wierszy', 'Nombre maximal de lignes',
        'Máximo de líneas', 'Maximale Zeilenzahl', 'الحد الأقصى للأسطر', 'מספר שורות מרבי',
      ],
      tone: ['Tone', 'Toon', 'Ton', 'Ton', 'Tono', 'Tonfall', 'النبرة', 'טון'],
    },
    outputs: {
      summary: ['Summary', 'Samenvatting', 'Podsumowanie', 'Résumé', 'Resumen', 'Zusammenfassung', 'الملخص', 'סיכום'],
    },
  },
  classify: {
    inputs: {
      text: TEXT,
      labels: ['Categories', 'Categorieën', 'Kategorie', 'Catégories', 'Categorías', 'Kategorien', 'الفئات', 'קטגוריות'],
    },
    outputs: {
      label: ['Category', 'Categorie', 'Kategoria', 'Catégorie', 'Categoría', 'Kategorie', 'الفئة', 'קטגוריה'],
      confidence: CONFIDENCE,
      reasoning: REASONING,
    },
  },
  'compare-docs': {
    inputs: {
      doc_a: [
        'First document', 'Eerste document', 'Pierwszy dokument', 'Premier document', 'Primer documento',
        'Erstes Dokument', 'المستند الأول', 'מסמך ראשון',
      ],
      doc_b: [
        'Second document', 'Tweede document', 'Drugi dokument', 'Second document', 'Segundo documento',
        'Zweites Dokument', 'المستند الثاني', 'מסמך שני',
      ],
    },
    outputs: {
      diff: ['Differences', 'Verschillen', 'Różnice', 'Différences', 'Diferencias', 'Unterschiede', 'الاختلافات', 'הבדלים'],
    },
  },
  'compose-claim-decision': {
    inputs: {
      claim_id: CLAIM_ID,
      amount: AMOUNT,
      decision: DECISION,
      note: ['Note', 'Notitie', 'Notatka', 'Note', 'Nota', 'Notiz', 'ملاحظة', 'הערה'],
    },
    outputs: {
      subject: ['Subject', 'Onderwerp', 'Temat', 'Objet', 'Asunto', 'Betreff', 'الموضوع', 'נושא'],
      body: [
        'Message text', 'Berichttekst', 'Treść wiadomości', 'Texte du message', 'Texto del mensaje',
        'Nachrichtentext', 'نص الرسالة', 'תוכן ההודעה',
      ],
    },
  },
  'example-claim-data': {
    inputs: DATA_IN,
    outputs: {
      ...DATA_OUT,
      claim_id: CLAIM_ID,
      amount: AMOUNT,
      status: STATUS,
      filed_date: [
        'Filing date', 'Indieningsdatum', 'Data zgłoszenia', 'Date de déclaration', 'Fecha de presentación',
        'Meldedatum', 'تاريخ التقديم', 'תאריך הגשה',
      ],
      policy_no: POLICY_NO,
    },
  },
  'example-customer-data': {
    inputs: DATA_IN,
    outputs: {
      ...DATA_OUT,
      customer_id: CUSTOMER_ID,
      name: ['Name', 'Naam', 'Imię i nazwisko', 'Nom', 'Nombre', 'Name', 'الاسم', 'שם'],
      email: ['Email', 'E-mailadres', 'Adres e-mail', 'E-mail', 'Correo electrónico', 'E-Mail', 'البريد الإلكتروني', 'אימייל'],
      tier: ['Tier', 'Klantniveau', 'Poziom', 'Niveau', 'Nivel', 'Stufe', 'المستوى', 'רמה'],
    },
  },
  'example-policy-data': {
    inputs: DATA_IN,
    outputs: {
      ...DATA_OUT,
      policy_no: POLICY_NO,
      holder: [
        'Policyholder', 'Verzekeringnemer', 'Ubezpieczający', 'Souscripteur', 'Tomador',
        'Versicherungsnehmer', 'حامل الوثيقة', 'בעל הפוליסה',
      ],
      premium: ['Premium', 'Premie', 'Składka', 'Prime', 'Prima', 'Prämie', 'القسط', 'פרמיה'],
      effective_date: [
        'Start date', 'Ingangsdatum', 'Data rozpoczęcia', 'Date d’effet', 'Fecha de inicio',
        'Beginndatum', 'تاريخ السريان', 'תאריך תחילה',
      ],
      expiry_date: [
        'End date', 'Einddatum', 'Data wygaśnięcia', 'Date d’échéance', 'Fecha de vencimiento',
        'Ablaufdatum', 'تاريخ الانتهاء', 'תאריך תפוגה',
      ],
    },
  },
  'extract-fields': {
    inputs: {
      document: ['Document', 'Document', 'Dokument', 'Document', 'Documento', 'Dokument', 'المستند', 'מסמך'],
      fields: ['Fields', 'Velden', 'Pola', 'Champs', 'Campos', 'Felder', 'الحقول', 'שדות'],
    },
    outputs: {
      values: ['Values', 'Waarden', 'Wartości', 'Valeurs', 'Valores', 'Werte', 'القيم', 'ערכים'],
      confidence: CONFIDENCE,
    },
  },
  'filter-rows': {
    inputs: {
      rows: ROWS,
      field: FIELD,
      op: ['Comparison', 'Vergelijking', 'Porównanie', 'Comparaison', 'Comparación', 'Vergleich', 'المقارنة', 'השוואה'],
      value: ['Value', 'Waarde', 'Wartość', 'Valeur', 'Valor', 'Wert', 'القيمة', 'ערך'],
    },
    outputs: { rows: ROWS, count: ROW_COUNT },
  },
  'flag-anomalies': {
    inputs: {
      records: ['Records', 'Gegevens', 'Rekordy', 'Enregistrements', 'Registros', 'Datensätze', 'السجلات', 'רשומות'],
      threshold: ['Threshold', 'Drempelwaarde', 'Próg', 'Seuil', 'Umbral', 'Schwellenwert', 'الحد', 'סף'],
    },
    outputs: {
      flagged: [
        'Flagged records', 'Gemarkeerde gegevens', 'Oznaczone rekordy', 'Enregistrements signalés',
        'Registros marcados', 'Markierte Datensätze', 'السجلات المعلَّمة', 'רשומות מסומנות',
      ],
    },
  },
  'format-output': {
    inputs: {
      content: ['Content', 'Inhoud', 'Treść', 'Contenu', 'Contenido', 'Inhalt', 'المحتوى', 'תוכן'],
      format: ['Format', 'Opmaak', 'Format', 'Format', 'Formato', 'Format', 'التنسيق', 'פורמט'],
    },
    outputs: {
      rendered: [
        'Formatted result', 'Opgemaakt resultaat', 'Sformatowany wynik', 'Résultat mis en forme',
        'Resultado con formato', 'Formatiertes Ergebnis', 'النتيجة المنسقة', 'תוצאה מעוצבת',
      ],
    },
  },
  'group-and-count': {
    inputs: {
      rows: ROWS,
      field: ['Group by', 'Groeperen op', 'Grupuj według', 'Grouper par', 'Agrupar por', 'Gruppieren nach', 'التجميع حسب', 'קיבוץ לפי'],
    },
    outputs: {
      groups: ['Groups', 'Groepen', 'Grupy', 'Groupes', 'Grupos', 'Gruppen', 'المجموعات', 'קבוצות'],
      total: ['Total', 'Totaal', 'Suma', 'Total', 'Total', 'Gesamt', 'الإجمالي', 'סך הכול'],
    },
  },
  'if-else': {
    inputs: {
      condition: ['Condition', 'Voorwaarde', 'Warunek', 'Condition', 'Condición', 'Bedingung', 'الشرط', 'תנאי'],
      if_true: ['If true', 'Indien waar', 'Jeśli prawda', 'Si vrai', 'Si es verdadero', 'Wenn wahr', 'إذا تحقق', 'אם מתקיים'],
      if_false: [
        'If false', 'Indien onwaar', 'Jeśli fałsz', 'Si faux', 'Si es falso', 'Wenn falsch', 'إذا لم يتحقق',
        'אם לא מתקיים',
      ],
    },
    outputs: { result: RESULT },
  },
  'load-dataset': { inputs: DATA_IN, outputs: DATA_OUT },
  'lookup-policy': {
    inputs: { policy_id: POLICY_NO },
    outputs: {
      coverage: ['Coverage', 'Dekking', 'Zakres ochrony', 'Couverture', 'Cobertura', 'Deckung', 'التغطية', 'כיסוי'],
      deductible: [
        'Deductible', 'Eigen risico', 'Udział własny', 'Franchise', 'Franquicia', 'Selbstbeteiligung',
        'مبلغ التحمل', 'השתתפות עצמית',
      ],
    },
  },
  'ocr-scan': {
    inputs: { image: ['Image', 'Afbeelding', 'Obraz', 'Image', 'Imagen', 'Bild', 'الصورة', 'תמונה'] },
    outputs: {
      text: [
        'Recognised text', 'Herkende tekst', 'Rozpoznany tekst', 'Texte reconnu', 'Texto reconocido',
        'Erkannter Text', 'النص المستخرج', 'טקסט שזוהה',
      ],
    },
  },
  'read-claim-form': {
    inputs: {
      file: ['File', 'Bestand', 'Plik', 'Fichier', 'Archivo', 'Datei', 'الملف', 'קובץ'],
      force_ocr: [
        'Always use OCR', 'Altijd OCR gebruiken', 'Zawsze używaj OCR', 'Toujours utiliser l’OCR',
        'Usar siempre OCR', 'Immer OCR verwenden', 'استخدام OCR دائمًا', 'תמיד להשתמש ב-OCR',
      ],
    },
    outputs: {
      text: TEXT,
      pages: ['Pages', 'Pagina’s', 'Strony', 'Pages', 'Páginas', 'Seiten', 'الصفحات', 'עמודים'],
      ocr_used: [
        'OCR used', 'OCR gebruikt', 'Użyto OCR', 'OCR utilisé', 'OCR utilizado', 'OCR verwendet',
        'تم استخدام OCR', 'נעשה שימוש ב-OCR',
      ],
    },
  },
  'read-customer-record': {
    inputs: { customer_id: CUSTOMER_ID },
    outputs: {
      record: [
        'Customer record', 'Klantgegevens', 'Dane klienta', 'Fiche client', 'Ficha de cliente',
        'Kundendatensatz', 'سجل العميل', 'רשומת לקוח',
      ],
    },
  },
  'record-form': {
    inputs: {
      record: ['Record', 'Gegevens', 'Rekord', 'Enregistrement', 'Registro', 'Datensatz', 'السجل', 'רשומה'],
      title: TITLE,
    },
    outputs: { form: ['Form', 'Formulier', 'Formularz', 'Formulaire', 'Formulario', 'Formular', 'النموذج', 'טופס'] },
  },
  'review-panel': {
    inputs: {
      item: [
        'Item to review', 'Te beoordelen onderdeel', 'Element do przeglądu', 'Élément à examiner',
        'Elemento a revisar', 'Zu prüfendes Element', 'العنصر المراد مراجعته', 'פריט לבדיקה',
      ],
    },
    outputs: {
      decision: DECISION,
      edited: [
        'Edited version', 'Bewerkte versie', 'Wersja po edycji', 'Version modifiée', 'Versión editada',
        'Bearbeitete Fassung', 'النسخة المعدلة', 'גרסה ערוכה',
      ],
    },
  },
  'rows-to-csv': {
    inputs: { rows: ROWS },
    outputs: {
      csv: ['CSV file', 'CSV-bestand', 'Plik CSV', 'Fichier CSV', 'Archivo CSV', 'CSV-Datei', 'ملف CSV', 'קובץ CSV'],
      columns: COLUMNS,
      row_count: ROW_COUNT,
    },
  },
  'summary-card': {
    inputs: {
      title: TITLE,
      stats: ['Key figures', 'Kerncijfers', 'Kluczowe dane', 'Chiffres clés', 'Cifras clave', 'Kennzahlen', 'الأرقام الرئيسية', 'נתונים עיקריים'],
      badge: ['Badge', 'Label', 'Etykieta', 'Badge', 'Distintivo', 'Kennzeichen', 'الشارة', 'תג'],
    },
    outputs: { card: ['Card', 'Kaart', 'Karta', 'Carte', 'Tarjeta', 'Karte', 'البطاقة', 'כרטיס'] },
  },
  'table-view': {
    inputs: { title: TITLE, rows: ROWS, columns: COLUMNS },
    outputs: { view: ['Table', 'Tabel', 'Tabela', 'Tableau', 'Tabla', 'Tabelle', 'الجدول', 'טבלה'] },
  },
  'triage-claim': {
    inputs: {
      claim: ['Claim', 'Claim', 'Roszczenie', 'Réclamation', 'Reclamación', 'Schadenfall', 'المطالبة', 'תביעה'],
    },
    outputs: {
      priority: ['Priority', 'Prioriteit', 'Priorytet', 'Priorité', 'Prioridad', 'Priorität', 'الأولوية', 'עדיפות'],
      severity: ['Severity', 'Ernst', 'Waga', 'Gravité', 'Gravedad', 'Schweregrad', 'الخطورة', 'חומרה'],
      rationale: REASONING,
    },
  },
};
