/// FR-5: das Claim-Präfix ist der Vertrag zum TypeScript-Filter
/// (`DELETE_CLAIM_PREFIX` in `src/core/cleanup.ts`, verwendet in `trash.ts` und
/// `compat.ts`); es entsteht an genau einer Stelle im Produktionscode.
#[test]
fn claim_praefix_literal_bleibt_im_produktionscode() {
    let production = crate::commands::test_util::production_source(include_str!("delete_claim.rs"));
    assert_eq!(
        production.matches("\".protium-delete-claim-{}\"").count(),
        1,
        "das claim-präfix muss genau einmal als literal im produktionscode stehen"
    );
}
