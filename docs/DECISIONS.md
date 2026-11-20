# Decisions to confirm before live use

The workspace owner records GB's actual decisions in `config/private/gb-decisions.json` (git-ignored; template in `config/gb-decisions.example.json`) and keeps the decision log outside the repository. This page lists the **kinds** of decision the tool needs.

**Performance**
- Assessment basis per plan: manager approval, or a recorded GB decision.
- Treatment of people without a plan.
- Internal initiatives: define them, or redistribute (N/A).
- Rating scale, precision and rounding, and bands.
- Reviewer and partner per person, with alternates.
- Evidence required on each item.
- Due dates for self-assessment, manager review and calibration.
- Clarification route.

**Time off and off-site work**
- Leave types and entitlements.
- Units (days or hours).
- Workweek and working hours.
- Half days.
- Notice rules and who approves exceptions.
- Carryover cap and expiry.
- Off-site quota and eligibility.
- Negative balances.
- Holiday calendar.
- Approvers and backups, including for partners.
- Cutover date and opening-balance basis.

**Data and cutover**
- Required vendor exports.
- Identity aliases.
- Import sign-off.
- Retention.

**AI**
- Export windows.
- Seat attribution.
- One login per person.
- Usage figures never used in ratings.

**Production**
- Sign-in.
- Host.
- Mail sender and test inbox.
- Partner grant policy.
- Enforced 2-Step Verification.
