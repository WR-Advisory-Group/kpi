# Canonical patch specification — kobocat image-attachment retention

Status: APPROVED FOR IMPLEMENTATION. Scope of THIS document: specify the patch
completely and deterministically. Producing the patch from this document MUST
yield the same result on any host, by any implementer (human or Claude model),
without access to the conversation that produced it.

Language convention: **MUST**, **MUST NOT**, **DO**, **STOP** are binding.
There are no optional or preferred paths. Where a real-world variation can
occur (e.g. a different kpi version), this document defines an explicit
DECISION GATE with a deterministic rule and, when a rule cannot be satisfied, a
mandatory STOP.

Definition — **STOP/ESCALATE**: halt implementation immediately, make no code
changes, and report to the human operator the exact gate that failed and the
observed vs expected text. Never "adapt", "guess", or force the patch past a
failed gate.

---

## 0. Problem statement (self-contained)

The destination KoboToolbox instance runs the merged `kpi`/`kobocat`
application (KoboCAT lives under `kobo/apps/openrosa/` inside the kpi source
tree). On every submission, KoboCAT calls `get_soft_deleted_attachments()` in
`kobo/apps/openrosa/libs/utils/logger_tools.py` (from `save_attachments()`).
That function builds a set of "referenced" attachment basenames by taking each
media question's XPath **from the currently-deployed form version** and running
`ElementTree.findall()` for that exact path against the submitted instance XML;
any stored attachment whose basename is not in that set is soft-deleted.

When a submission was collected against an **older form version** whose
structure differs from the deployed version — most commonly because Kobo
regenerates auto group names on structural edits (e.g. `begin_group_nJmLeNw9K`
in an old version vs `begin_group_5CZVtsKAx` in the deployed version) — the
deployed XPath does not resolve in the historical instance, the image's
basename is never collected, and the image attachment is soft-deleted right
after being accepted (HTTP 201). Audio is spared only by a hardcoded filename
exemption for background audio (`^\d{10,}\.(m4a|amr)$`). Net effect: migrating
historical submissions silently loses image attachments while keeping audio.

**Canonical fix contract**: retention MUST be decided by whether an
attachment's basename appears as a **node value anywhere in the submitted
instance XML**, not by a version-specific XPath match. This is robust to
form-version structural drift and preserves edit semantics (a replaced file's
old basename is absent from the new instance and is therefore still
soft-deleted).

---

## 1. Target identification (version-agnostic)

1.1. The patched source file, hereafter `TARGET_FILE`, is the file matching
this path suffix inside the kpi source tree:
`kobo/apps/openrosa/libs/utils/logger_tools.py`.

1.2. To locate it in a working checkout, DO run:
```
find . -path '*/kobo/apps/openrosa/libs/utils/logger_tools.py' -not -path '*/node_modules/*'
```
Exactly one path MUST be returned. Zero or more than one → STOP/ESCALATE.

1.3. The patched function, hereafter `TARGET_FN`, is `get_soft_deleted_attachments`.
Confirm it exists:
```
grep -n 'def get_soft_deleted_attachments' TARGET_FILE
```
Exactly one match MUST be returned. Zero → STOP/ESCALATE (the version has
refactored attachment handling; a human decision is required). More than one →
STOP/ESCALATE.

---

## 2. PRECHECK & DECISION GATES (execute fully BEFORE any edit)

Run every gate in order. Any STOP is terminal.

### GATE A — Idempotency (is the patch already applied?)
Run:
```
grep -n 'xml_parsed.iter()' TARGET_FILE
```
- If the function `TARGET_FN` already contains a `basenames` assignment built
  from `xml_parsed.iter()` (the patched form, §3.2) → the patch is ALREADY
  APPLIED. DO skip §3 entirely and proceed to §4 (tests) and §5 (deploy/verify)
  only as needed. Record "already applied".
- Otherwise continue to GATE B.

### GATE B — Reference-match classification
Extract the body of `TARGET_FN` and compare against the REFERENCE BODY in
§3.1. Classify into exactly one:

- **B1 — Exact match**: the region from the line `basenames = []` through the
  end of the basename-collection `for` loop is byte-for-byte identical to
  §3.1 lines marked `‹replace-start›…‹replace-end›` (ignoring nothing — exact).
  → Apply §3 using the verbatim replacement (§3.2). Deterministic.

- **B2 — Structural match with cosmetic drift**: `TARGET_FN` still (a) parses
  the instance into a variable via a single statement of the form
  `<var> = <parser>(instance.xml)`, (b) initializes a list `basenames`, and (c)
  populates `basenames` by iterating `media_question_xpaths` and appending
  `question.text` values obtained via `findall(...)`; but there are cosmetic
  differences (whitespace, comment wording, line wrapping, or the parser
  helper name differs). → Apply the SEMANTIC TRANSFORM (§3.3). The parse
  statement (a) MUST be kept exactly as the version already has it; only the
  `basenames` initialization + population loop (b)+(c) are replaced.

- **B3 — Material divergence**: any of the following is true → STOP/ESCALATE.
  - No list named `basenames` (or its consumer) exists.
  - Retention is no longer decided by `attachment.media_file_basename in
    <set built from basenames>`.
  - The soft-delete no longer works by set-membership of basenames (e.g. the
    algorithm was rewritten to compare hashes or DB relations only).

### GATE C — Downstream invariant (MUST hold for the patch to be valid)
Within `TARGET_FN`, AFTER the basename-collection region, all three MUST be
present (allowing cosmetic differences). Verify by reading the code:
1. A set is built from `basenames` (reference: `basename_set = set(basenames)`).
2. Attachments are iterated and kept iff
   `attachment.media_file_basename in basename_set` (reference lines
   §3.1 near `for attachment in queryset:`).
3. Non-matching attachments are soft-deleted (reference:
   `remaining_attachments.update(... delete_status=...SOFT_DELETED)`).
If any is absent → STOP/ESCALATE (this is the B3 condition surfacing late).

### GATE D — Parser symbol availability
Identify the exact parse statement in `TARGET_FN` (reference:
`xml_parsed = fromstring_preserve_root_xmlns(instance.xml)`). The patch REUSES
this statement verbatim and REUSES its result variable (reference name:
`xml_parsed`). DO NOT introduce a new parser. If no such single parse statement
exists → STOP/ESCALATE.

### GATE E — Import hygiene
The patch removes the only in-function uses of `XPathNotFoundException`, the
`assert root_name == xml_parsed.tag` block, and its `logging.warning(...)`.
DO NOT remove or alter any `import` statements in `TARGET_FILE`, even if a
symbol becomes unused after patching. Unused imports are acceptable and MUST be
left intact to avoid breaking other call sites.

---

## 3. The patch

### 3.1 REFERENCE BODY (verbatim; kpi image `kobotoolbox/kpi:2.026.21b`)

The region to replace is delimited `‹replace-start›`/`‹replace-end›` (those
markers are annotations, not code). Everything outside the markers MUST remain
unchanged.

```python
def get_soft_deleted_attachments(instance: Instance) -> list[Attachment]:
    """
    Soft delete replaced attachments when editing a submission
    """
    # Retrieve all media questions of Xform
    media_question_xpaths = get_xform_media_question_xpaths(instance.xform)

    # If XForm does not have any media fields, do not go further
    if not media_question_xpaths:
        return []

    # Parse instance XML to get the basename of each file of the updated
    # submission
    xml_parsed = fromstring_preserve_root_xmlns(instance.xml)
# ‹replace-start›
    basenames = []

    for media_question_xpath in media_question_xpaths:
        root_name, xpath_without_root = media_question_xpath.split('/', 1)
        try:
            assert root_name == xml_parsed.tag
        except AssertionError:
            logging.warning(
                'Instance XML root tag name does not match with its form'
            )

        # With repeat groups, several nodes can have the same XPath. We
        # need to retrieve all of them
        questions = xml_parsed.findall(xpath_without_root)
        for question in questions:
            try:
                basename = question.text
            except AttributeError:
                raise XPathNotFoundException

            # Only keep non-empty fields
            if basename:
                basenames.append(basename)
# ‹replace-end›

    # Update Attachment objects to hide them if they are not used anymore.
    # ... (unchanged through end of function)
```

### 3.2 REPLACEMENT TEXT (verbatim)

Replace the `‹replace-start›…‹replace-end›` region (i.e. the original
`basenames = []` line through the final `basenames.append(basename)` line,
inclusive) with EXACTLY this text (indentation is 4 spaces; the block sits at
one indent level inside the function):

```python
    # PATCH(kobo-migration, attachment-retention): retention is decided by
    # whether an attachment's basename appears as a node value ANYWHERE in the
    # submitted instance, instead of at a media-question XPath derived from the
    # currently-deployed form. The XPath approach (get_xform_media_question_xpaths)
    # fails when a submission was collected against an older form version whose
    # structure — e.g. auto-generated group names — differs from the deployed
    # version, wrongly soft-deleting image attachments while background audio
    # survived only via the exemption below. Value matching is robust to that
    # drift and still soft-deletes replaced attachments on edits, because a
    # replaced file's old basename is absent from the new instance XML.
    basenames = [
        element.text.strip()
        for element in xml_parsed.iter()
        if element.text and element.text.strip()
    ]
```

Rules for §3.2:
- The parse statement `xml_parsed = fromstring_preserve_root_xmlns(instance.xml)`
  immediately above the region MUST remain unchanged.
- The comment lines `# Parse instance XML ...` immediately above the parse
  statement MUST remain unchanged.
- The result variable MUST be whatever the retained parse statement assigns
  (reference: `xml_parsed`). If GATE D found a different variable name, use
  that name in the comprehension instead of `xml_parsed`. No other change.
- Everything from `# Update Attachment objects...` onward MUST remain unchanged.

### 3.3 SEMANTIC TRANSFORM (only when GATE B classified B2)

When cosmetic drift prevents a verbatim region match, DO perform exactly this,
and nothing else:
1. Keep the version's existing instance-parse statement and its result
   variable name `V`.
2. Delete the version's `basenames` initialization and the loop that populates
   `basenames` from `media_question_xpaths`/`findall`.
3. Insert, in their place, the §3.2 block, substituting `V` for `xml_parsed`.
4. Leave the early-return guard (`if not media_question_xpaths: return []`),
   the attachment queryset + exemptions, the match loop, and the soft-delete
   update exactly as the version has them.

### 3.4 Post-edit static check
After editing, DO run a syntax check on `TARGET_FILE`:
```
python -m py_compile TARGET_FILE
```
Non-zero exit → revert the edit and STOP/ESCALATE.

---

## 4. Regression tests (add to the kpi repo)

Intent (canonical): prove that an image attachment referenced by a node whose
group path does NOT match the deployed form's media XPath is RETAINED after the
patch, and that edit-time replacement still soft-deletes.

4.1. DO locate the existing test module that already exercises
`get_soft_deleted_attachments` or `save_attachments`:
```
grep -rln 'get_soft_deleted_attachments\|def test_.*attachment' \
  kobo/apps/openrosa --include=*.py
```
Add the new tests to the existing attachment test module returned (mirror its
imports and fixtures). If none exists, create
`kobo/apps/openrosa/apps/logger/tests/test_attachment_retention_patch.py` and
mirror fixture setup from the nearest existing logger test that builds an
`XForm` + `Instance` + `Attachment`.

4.2. Tests to add (canonical behaviors; adapt only fixture/builder names to the
version's existing helpers — this is an allowed minor adaptation):
- `test_image_retained_when_group_path_differs_from_deployed_form`: deploy a
  form whose image question is nested under group name `G_NEW`; save an instance
  whose image node is nested under a DIFFERENT group name `G_OLD` with an image
  attachment; call the submission/attachment-save path; assert the image
  attachment's `delete_status` is not soft-deleted and it remains queryable.
- `test_edit_replacement_still_soft_deletes`: save a submission with image A;
  submit an edit (same instanceID via deprecatedID) referencing image B; assert
  A is soft-deleted and B is retained.
- `test_photo_and_background_audio_both_retained`: one instance with an image
  and a background-audio file; assert both retained.
- `test_no_media_form_unaffected`: a form with no media questions triggers the
  early return and soft-deletes nothing.

4.3. DO run the added tests with the repo's configured test runner and confirm
all pass. Report the exact command used and its output.

Note: §4 is a regression guard. The AUTHORITATIVE proof of the fix is the live
verification in §6, which does not depend on kpi test fixtures.

---

## 5. Build and deploy the patched image (canonical, version-agnostic)

The soft-delete runs synchronously in the submission request path served by the
kpi web container, and related processing can run in celery workers. Therefore
ALL running services that use the kpi image MUST run the patched code.

5.1. Determine the EXACT base image reference currently deployed. On the
destination host DO run:
```
docker inspect --format '{{.Config.Image}}' "$(docker ps --filter name=kpi --format '{{.Names}}' | head -n1)"
```
Record the returned reference as `BASE_IMAGE` (e.g.
`kobotoolbox/kpi:2.026.21b`). DO NOT hardcode a tag; use whatever this returns.

5.2. Create a build context containing the fully-patched `logger_tools.py`
(produced per §3, verified per §3.4) at the SAME repo-relative path it occupies
in the image. Discover that in-container path:
```
docker exec "$(docker ps --filter name=kpi --format '{{.Names}}' | head -n1)" \
  sh -lc 'find / -path "*/kobo/apps/openrosa/libs/utils/logger_tools.py" 2>/dev/null'
```
Record it as `CONTAINER_TARGET_PATH` (reference:
`/srv/src/kpi/kobo/apps/openrosa/libs/utils/logger_tools.py`).

5.3. `Dockerfile` (canonical form):
```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY logger_tools.py CONTAINER_TARGET_PATH
```
Substitute the literal `CONTAINER_TARGET_PATH` from §5.2. Build with a
deterministic derived tag that encodes the base and a patch revision:
```
docker build --build-arg BASE_IMAGE="$BASE_IMAGE" \
  -t "${BASE_IMAGE}-wrpatch-attach1" .
```
`-wrpatch-attach1` is the fixed canonical suffix for THIS patch revision.

5.4. Point every kpi-based service at the patched tag and recreate them. In the
active kobo-docker frontend compose, set the `image:` of every service whose
image equals `BASE_IMAGE` to `${BASE_IMAGE}-wrpatch-attach1`, then:
```
docker compose up -d
```
If the deployment is managed by kobo-install (which regenerates compose from
templates), the tag substitution MUST be re-applied after any kobo-install run;
§6.1 is the gate that detects a lost patch.

---

## 6. Verification (authoritative; run in order; each is a gate)

6.1. **Patched code is live in every kpi container.** For EACH container whose
image is `BASE_IMAGE`-derived:
```
docker exec <container> sh -lc 'grep -c "PATCH(kobo-migration, attachment-retention)" CONTAINER_TARGET_PATH'
```
Every container MUST return `1`. Any `0` → the deploy did not take; STOP and
fix §5 before proceeding.

6.2. **Live attachment retention.** Using the migration tool: `rollback` the
form previously observed to lose photos (the 13-record form whose image
question `litrato` sits in a versioned group), then re-migrate that single
form. Then confirm the image attachments are present (not merely the node
values) on the destination — i.e. `_attachments` for a submission includes the
`.jpg`, and the file downloads with HTTP 200 — and that the migration tool's
`verify` reports source/destination attachment counts as equal.

6.3. **Edit semantics intact.** On the destination, submit then edit a test
form's image (replace the file); confirm the replaced (old) image is
soft-deleted and only the new image remains.

A patch that fails 6.1 or 6.2 MUST NOT be considered applied.

---

## 7. Rollback of the patch

Repoint every affected service's `image:` back to `BASE_IMAGE` and run
`docker compose up -d`. No data change is required to revert; attachments
already retained under the patched logic are unaffected. Removing the patched
image tag is optional cleanup.

---

## 8. Sequencing and interaction with migration

8.1. The full/production migration MUST run only AFTER §6.1 and §6.2 pass, so
no form needs reprocessing.

8.2. Forms already migrated before the patch (photos dropped) MUST be corrected
by `rollback` + re-migrate of those forms; re-running alone does not restore
dropped attachments, because the destination deduplicates by instanceID
(HTTP 202) and will not re-ingest the missing files without a fresh instance.

8.3. This patch requires NO change to the migration tool's code.

---

## 9. Canonical decision-rule summary (quick reference)

- Locate `TARGET_FILE`/`TARGET_FN` deterministically; ambiguity → STOP.
- Already patched (GATE A) → skip editing.
- Exact reference match (B1) → apply §3.2 verbatim.
- Cosmetic drift (B2) → apply §3.3 semantic transform (keep the version's parse
  statement + variable; replace only the basename build).
- Retention algorithm materially changed (B3) or downstream invariants absent
  (GATE C) or no single parse statement (GATE D) → STOP/ESCALATE.
- Never remove imports (GATE E).
- Base image tag and in-container path are READ from the running deployment,
  never assumed.
- The patch is proven only by §6.1 (code live in all containers) + §6.2 (live
  retention) + §6.3 (edit semantics).
