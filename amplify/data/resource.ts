import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { askMedGemma } from '../functions/ask-medgemma/resource';
import { askNovaMicro } from '../functions/ask-nova-micro/resource';
import { logConversationEvent } from '../functions/log-conversation-event/resource';
import { getConversationLogs } from '../functions/get-conversation-logs/resource';
import { fetchAllergyNews } from '../functions/fetch-allergy-news/resource';
import { extractLabelText } from '../functions/extract-label-text/resource';

const schema = a.schema({
  // ── User profile ────────────────────────────────────────────────────────────
  UserProfile: a.model({
    name: a.string(),
    age: a.integer(),
    dateOfBirth: a.string(),         // ISO 'YYYY-MM-DD' — printed on the clinician export
    medicalHistory: a.string(),
    notificationPrefs: a.string(),   // JSON string for notification toggles
    caregiverRelationship: a.string(),  // e.g. 'Mother', 'Father', 'Guardian'
    contactEmail: a.string(),
    contactPhone: a.string(),
    onboardingComplete: a.boolean(),
    pronouns: a.string(),            // 'she/her' | 'he/him' | 'they/them' | free text
    avatarKey: a.string(),           // aquatic avatar id, e.g. 'octopus'
  }).authorization(allow => [allow.owner()]),

  // ── Health entries (Symptom Logger) ────────────────────────────────────────
  HealthEntry: a.model({
    type: a.string().required(),       // 'Exposure' | 'Symptom' | 'Medication'
    subtype: a.string(),               // e.g. 'Meal', 'Product'
    name: a.string().required(),
    severity: a.integer(),
    bodyArea: a.string(),
    notes: a.string(),
    tags: a.string(),                  // JSON string array
    details: a.string(),
    dose: a.string(),
    unit: a.string(),
    route: a.string(),
    reason: a.string(),
    time: a.string().required(),
    quantity: a.string(),              // e.g. '250' — paired with quantityUnit
    quantityUnit: a.string(),          // 'grams' | 'oz' | 'ml' | 'pieces' | 'cups' | ...
    ocrIngredients: a.string(),        // raw text extracted from ingredients-label photo(s)
    ocrNutrition: a.string(),          // raw text extracted from nutrition-facts photo
    containsSummary: a.string(),       // "This food contains: peanuts, milk" derived from OCR text
    followUpAt: a.string(),            // ISO datetime Bea should check back in; null = no check-in
    followUpStatus: a.string(),        // 'pending' | 'ongoing' | 'resolved'

    // ── Clinical export fields ───────────────────────────────────────────────
    // These are deliberately nullable strings rather than booleans/enums: the
    // export has to distinguish "answered no" from "never asked", and a clinical
    // document that prints a confident 0 for data nobody collected is worse than
    // one that prints "not recorded".
    familyMemberId: a.string(),        // which patient this entry is about; null = profile owner
    resolvedAt: a.string(),            // ISO datetime the symptom cleared
    resolvedPrecision: a.string(),     // 'exact' (user gave a time) | 'confirmed-by' (upper bound from a check-in)
    relatedEntryId: a.string(),        // symptom ↔ the medication entry taken for it
    epinephrineAvailable: a.string(),  // 'yes' | 'no' — absent means never asked
    emergencyCare: a.string(),         // 'none' | 'urgent-care' | 'emergency-room' | 'ambulance'
    cofactors: a.string(),             // JSON string array, e.g. ["Exercise","High pollen"]
  }).authorization(allow => [allow.owner()]),

  // ── Medications (schedule) ────────────────────────────────────────────────
  Medication: a.model({
    // Which patient this prescription belongs to; null = the profile owner.
    // Without it a household shared one medication list, so switching to a
    // child still showed the parent's doses — and the clinician export listed
    // every person's medication under whoever it was generated for.
    familyMemberId: a.string(),
    name: a.string().required(),
    dose: a.string(),
    unit: a.string(),
    route: a.string(),
    timeLabel: a.string(),       // 'Morning' | 'Afternoon' | 'Evening' | 'Night' | 'As needed'
    scheduledTime: a.string(),   // 'HH:MM' 24-hour; null for 'as needed'
    frequency: a.string(),       // free text, e.g. 'once', 'twice daily'
    active: a.boolean(),
  }).authorization(allow => [allow.owner()]),

  // ── Medication doses actually taken ──────────────────────────────────────
  // Deliberately carries no familyMemberId: a dose belongs to a medication,
  // which belongs to a person. Storing the patient here too would let the two
  // disagree, so readers scope logs by the medications they already filtered.
  MedicationLog: a.model({
    medicationId: a.string().required(),
    takenAt: a.string().required(),   // full ISO datetime
  }).authorization(allow => [allow.owner()]),

  // ── Exposure tests ────────────────────────────────────────────────────────
  ExposureTest: a.model({
    // Which patient was tested; null = the profile owner. A tolerance result
    // is about one person and must never be read as another's.
    familyMemberId: a.string(),
    testName: a.string().required(),
    allergen: a.string().required(),
    amount: a.float(),
    unit: a.string(),
    servingContext: a.string(),
    protocol: a.string(),
    baselineSymptoms: a.string(),
    testDate: a.string().required(),
    testTime: a.string(),
    monitoringDuration: a.string(),
    reminders: a.string(),            // JSON string array
    status: a.string().required(),    // 'planned' | 'active' | 'completed'
    results: a.string(),
    reactions: a.string(),
  }).authorization(allow => [allow.owner()]),

  // ── Family members ────────────────────────────────────────────────────────
  FamilyMember: a.model({
    name: a.string().required(),
    relationship: a.string().required(),  // e.g. 'Spouse', 'Child', 'Parent', 'Sibling'
    age: a.integer(),                     // whole years; 0 when under 1 (see ageMonths)
    ageMonths: a.integer(),               // set only when the member is under 1 year old
    dateOfBirth: a.string(),              // ISO date 'YYYY-MM-DD', optional alternate to age/ageMonths
    knownAllergies: a.string(),           // comma-separated or free text
    medicalConditions: a.string(),
    medications: a.string(),
    notes: a.string(),
    // Bea speaks *about* this person to the caregiver, so it needs their
    // pronouns explicitly — inferring them from a first name gets people wrong.
    pronouns: a.string(),                 // 'she/her' | 'he/him' | 'they/them' | free text
    avatarKey: a.string(),                // aquatic avatar id, e.g. 'seahorse'
  }).authorization(allow => [allow.owner()]),

  // ── Chat threads ─────────────────────────────────────────────────────────
  // One conversation with Bea, about exactly one person. Threads are per-patient
  // rather than per-account because a caregiver's chat about one child must not
  // carry the other child's symptoms into its context.
  ChatThread: a.model({
    familyMemberId: a.string(),          // which patient this thread is about; null = profile owner
    title: a.string(),                   // derived from the first user message
    startedAt: a.string().required(),    // ISO datetime
    lastMessageAt: a.string().required(),// ISO datetime — threads are listed by this
    messageCount: a.integer(),
  }).authorization(allow => [allow.owner()]),

  // ── Chat messages ────────────────────────────────────────────────────────
  ChatMessage: a.model({
    threadId: a.string().required(),
    familyMemberId: a.string(),          // denormalized so one person's messages are queryable directly
    role: a.string().required(),         // 'user' | 'assistant'
    content: a.string().required(),
    // Named sentAt, not createdAt: Amplify generates createdAt/updatedAt itself
    // and a field of that name would collide.
    sentAt: a.string().required(),       // ISO datetime
  }).secondaryIndexes(index => [index('threadId').sortKeys(['sentAt'])])
    .authorization(allow => [allow.owner()]),

  // ── Community posts ──────────────────────────────────────────────────────
  CommunityPost: a.model({
    authorUsername: a.string(),       // null when anonymous
    anonymous: a.boolean(),
    title: a.string().required(),
    content: a.string().required(),
    likes: a.integer(),
  }).authorization(allow => [
    allow.owner(),
    allow.authenticated().to(['read', 'update']), // any auth user can like
  ]),

  // ── Community post comments ──────────────────────────────────────────────
  PostComment: a.model({
    postId: a.string().required(),
    authorUsername: a.string(),       // null when anonymous
    anonymous: a.boolean(),
    content: a.string().required(),
  }).authorization(allow => [
    allow.owner(),
    allow.authenticated().to(['read', 'create']), // any auth user can read/add comments
  ]),

  // ── Post likes — one row per (post, user) enforces one like per account ──
  PostLike: a.model({
    postId: a.string().required(),
    userId: a.string().required(),
  }).identifier(['postId', 'userId'])
    .authorization(allow => [
      allow.owner(),
      allow.authenticated().to(['read', 'create']), // any auth user can like; only the liker can unlike (owner-only delete)
    ]),

  // ── Allergy news (scraped on a schedule by fetchAllergyNews) ─────────────
  NewsArticle: a.model({
    title: a.string().required(),
    url: a.string().required(),
    source: a.string(),
    publishedAt: a.string(),
    fetchedAt: a.string(),
  }).authorization(allow => [
    allow.authenticated().to(['read']),
  ]),

  // ── MedGemma (detailed medical — Colab/Ngrok) ────────────────────────────
  askMedGemma: a.query()
    .arguments({ question: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(askMedGemma)),

  // ── Nova Micro (fast casual — AWS Bedrock) ───────────────────────────────
  // history: JSON string of last N turns [{ role, content }]
  // context: compact session summary (allergies, current topic, symptoms)
  // mode:    'chat' (default) or 'extract' — 'extract' swaps the companion
  //          persona for a terse JSON-only prompt at temperature 0. Without it
  //          the persona ("write in full, natural sentences") fights callers
  //          that need structured output, e.g. the voice logger.
  askNovaMicro: a.query()
    .arguments({ question: a.string(), history: a.string(), context: a.string(), mode: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(askNovaMicro)),

  // ── Conversation event logger (DynamoDB) ─────────────────────────────────
  logConversationEvent: a.query()
    .arguments({ userId: a.string(), event: a.string() })
    .returns(a.boolean())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(logConversationEvent)),

  // ── Conversation logs reader (DynamoDB) ──────────────────────────────────
  getConversationLogs: a.query()
    .arguments({ userId: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(getConversationLogs)),

  // ── OCR label/nutrition-facts text extraction (AWS Textract) ─────────────
  // images: JSON string array of base64-encoded image bytes (no data: prefix)
  extractLabelText: a.query()
    .arguments({ images: a.string() })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(extractLabelText)),
}).authorization(allow => [
  // Grants fetchAllergyNews IAM access to the Data API (used to write/prune NewsArticle rows).
  allow.resource(fetchAllergyNews),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
