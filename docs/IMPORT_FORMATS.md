# Import formats

Every import uses the same flow: **upload → preview → apply → (reverse)**.

- **Preview** writes nothing except the batch record. It shows matches, rejected rows, issues and excluded columns.
- **Apply** is a single transaction. A re-upload of an identical file returns the existing batch.
- **Matching** uses verified work email first, then verified aliases (Admin → aliases). People are never created, merged or deactivated automatically. Name-only matches go to *review*.
- **Never read**: salary, bonus, increase, compensation, pay or payroll, social security, age, working-day counts, hobbies and other unrelated personal fields. Sheets named like *Salaries* are refused.

## GB 2026 evaluation form (`Admin → Import center → GB 2026 evaluation forms`)

The importer reads the "2026 Employee Eval. Form" layout used in the PMS 2026 role folders, and accepts several files at once.

**Fields read**
- Name, Position and Date of Joining.
- Objectives, Competencies and Internal Initiatives, with the section weight taken from the header and from the criteria table.
- For each item: title, description, KPI, weight, target, target date, approval, level, actual, self and supervisor ratings and comments.

**Clean-up**
- "Insert … here" placeholders are treated as blank.
- The template's example on objective 1 is detected and ignored: "Failed in delivery of project", rating 3, "Target not achieved fully but within range".
- Weights stored as times (0.2 shown as 04:48) are recovered and flagged.

**Formula audit (reported, never trusted)**
- `#REF!` errors.
- Section scores that miss rows or multiply by the wrong weight cell.
- `AVERAGE` used where a weighted sum is needed.
- Criteria rows that point at the wrong section (for example `D61 =O55`).
- A missing total formula.

**Result**
- A draft plan with basis *unverified*.
- The weight and approval problems listed per person.
- The plan cannot be approved until category and item weights are valid and objectives have targets.

## PMS plans, one row per item

| Column | Required | Notes |
|---|---|---|
| Email | yes | Verified work email |
| Cycle / Year | no | Must equal the target cycle |
| Category | yes | Objective / Competency / Initiative |
| Category weight | recommended | `40%`, `0.4` or `40` |
| Item / Objective / Title | yes | |
| KPI, Target, Expected proficiency | no | |
| Weight | yes | Item weight within its category |
| Plan status, Approved by | no | "Approved" plus an approver is shown as a note; the manager still confirms in Prism |

## PMS history team summary (for example the PMS tab of *GB Team 2025 PMS*)

- **Columns**: `Employee`, `Current Title`, dimension columns named `Name (NN%)`, `Total Performance Score`, `Performance Rationale`.
- **Checks**: the total is recomputed with the configured precision (1 dp, half up, reproduces all 8 rows of 2025). Identical rationales are flagged.
- **Result**: closed historical plans. Source values are kept verbatim and never re-scored.

## LeaveBoard

| Report | Detected by | What happens |
|---|---|---|
| General Situation | `Employee, Working, Worked, …` | Named rows are stored as a vendor snapshot. The unlabeled totals row is a **checksum**, and any mismatch blocks the import. **Zero ledger entries.** The reporting range is entered by the importer; the generation time comes from *Details*. |
| Annual Situation | `Employee, Year, <Cat> - Used/Available/Allowance` | Checks Used + Available = Allowance per row and category; decimals are kept exactly; negative availability is flagged. Stored as a **candidate** balance snapshot. *Post opening balances* writes `opening = Available` per user, type and year, keyed so a re-run is a no-op and a different value is reported. |
| Attendance | `Employee, Su 1, Mo 2, …` plus the `Attendance for MM/DD/YYYY - MM/DD/YYYY` footer | Daily raw values and codes are kept (`8`, `4/SL`, `8WFH`, `COO`, …). Dates after generation are marked future. **Zero ledger entries.** |
| Leaves (dated) | `ID, Employee, Leave type, Start, End, …, Status` | Imported as requests with the vendor ID (de-duplicated across re-imports). Approved items are treated as already inside the opening balance: no second deduction. Pending items reserve; later approval posts the usage once; cancelling an imported future booking credits it back once. **The column layout must be confirmed against a real export.** |
