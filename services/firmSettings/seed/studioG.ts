/**
 * Studio G activity pinning seed.
 *
 * Drives resolveActivityForEntry() default activity selection.
 * Decided in chat — see chat history and product spec § 1.2 (Quality Floor).
 *
 * To change a pin:
 * 1. Edit the value in this file
 * 2. Bump STUDIO_G_FIRM_SETTINGS_VERSION in services/firmSettings.ts
 * 3. Commit, build, push to TestFlight — all users pick up the new
 *    seed on next app launch
 */

export const STUDIO_G_ACTIVITY_PINNING = {
  byGroup: {
    // 00 Contracts & Negotiations → OB- Contracts Preparation & Negotiation
    "7ac25acd-3b03-4841-ae00-883b9056088b": "02073ccd-aa44-4285-b0c3-17d0ee592110",

    // 01 Consulting → DS- Consulting Hourly
    "763d2a2f-ec62-4a6b-acb9-5ee37f19250f": "69d507a5-e5eb-49f6-9446-4420a6e5a202",

    // 10 Pre-Design → DS- Programming
    "94a1136b-e2d2-4abc-ad54-4151d7896e6d": "4ffd5947-eaab-43b1-8d4e-e541593a49d2",

    // 20 Schematic Design → PR- Deliverable SD Set Drafting
    "1c75db1e-e03b-4f5b-9ced-2f051733d39b": "ef029e89-4791-40ab-90c3-581e89a4d2da",

    // 30 Design Development → PR- Deliverable DD Set Drafting
    "96777d25-14ee-420f-b6c7-2e586493bb69": "30b0c2e4-3c14-415e-b741-f562bf62d728",

    // 40 Entitlement (Planning) → PR- Deliverable Planning Set Drafting
    "934585d5-1a8b-4795-87cd-ee46a865dba2": "73c66b48-6db9-445c-bd00-a9e97b687af5",

    // 50 Construction Documents → PR- Deliverables CD Set Drafting
    "3f53c3f6-6825-4543-9829-05c7e08e5d43": "1d133a7c-36a4-49df-9e88-7b605bf8f206",

    // 60 Permits & Approvals → PA- Applications and submittal Docs
    "128fd256-b2b2-42ae-a19d-f880cf269bae": "5823c00e-80d4-46da-a33b-264951436551",

    // 70 Bidding → BN- Bid Response to RFI's
    "4fcdfef7-c411-455b-b58a-5d6e05af7899": "8eda528e-1ffe-446b-9043-e0f891df7789",

    // 80 Construction Administration → CA- Construction Responses (RFI- addenda - SK)
    // Known v1 limitation: many CA days are site visits, not RFIs.
    // Brief beta PMs that this activity may need manual fix in BQE.
    "aec3bb5d-fd0e-4aa6-9e43-7db73ffa15b3": "68be7b07-3c29-41ce-a68a-76acdbafa4cd",

    // 90 FF&E → DS- ID FF&E
    "8d885dcb-21d0-4601-aed4-f05b4b49263c": "fa770d2c-3761-4088-92c2-d470782ef64d",

    // Studio G Activities (catch-all) → PM- Project Coordination
    "04419c13-b630-42cc-b320-8b756fccf7e1": "636f84c9-dd04-435b-a86f-c8df36751977",

    // Overhead (OA, OM, OP) Activities Group is intentionally NOT pinned at the
    // group level — per-project overrides below handle each overhead project
    // individually. Any other project bound to this group falls through to
    // first-billable fallback.
  },

  byProject: {
    // Office Overhead 0000.00 → OA- Administration Misc.
    "09b1c392-6451-4216-bb36-7ad0f9af9479": "915d7070-24b7-4307-9a2d-a52fc8d8710c",

    // PTO 0000.01 → OP- PTO
    "eb2cdb74-4dbe-4876-808f-f542ae8599b1": "ab4a5391-1010-4870-ab96-8f95814ceec3",

    // Holiday 0000.02 → OP- Holiday
    "c0ef8feb-c84d-445d-b780-2d4b3a3c311d": "6c276098-b645-44ee-8001-a3013df602f6",

    // Marketing 0000.03 → OM- Marketing
    "a0d8c928-df47-47a3-8d7e-5a4e6bf09cff": "4b207950-975f-4d0c-9744-7ef1844da4f2",
  },
};

export type ActivityPinning = typeof STUDIO_G_ACTIVITY_PINNING;
