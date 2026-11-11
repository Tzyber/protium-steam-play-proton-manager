use super::*;

#[tokio::test]
async fn unverified_confirmation_naht_bindet_404_warning_okcancel_und_ablehnung() {
    let mut shown = false;
    let rejected = confirm_unverified_installation(
        "GE-Proton11-3",
        "GE-Proton11-3",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum",
        DialogLocale::De,
        |request| {
            shown = true;
            assert_eq!(request.kind, ConfirmationKind::Warning);
            assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
            assert!(request.message.contains("HTTP 404"));
            std::future::ready(Ok(false))
        },
    )
    .await
    .unwrap();
    assert!(shown);
    assert!(!rejected, "native ablehnung darf nicht fortsetzen");

    let accepted = confirm_unverified_installation(
        "GE-Proton11-3",
        "GE-Proton11-3",
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum",
        DialogLocale::De,
        |request| {
            assert_eq!(request.kind, ConfirmationKind::Warning);
            assert_eq!(request.buttons, ConfirmationButtons::OkCancel);
            std::future::ready(Ok(true))
        },
    )
    .await
    .unwrap();
    assert!(
        accepted,
        "native zustimmung muss nur den 404-fall fortsetzen"
    );
}

#[test]
fn unverified_confirmation_text_folgt_der_locale() {
    let tag = "GE-Proton11-3";
    let url = "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-3/GE-Proton11-3.sha512sum";
    let de = unverified_confirmation_request(tag, tag, url, DialogLocale::De);
    assert_eq!(de.kind, ConfirmationKind::Warning);
    assert_eq!(de.buttons, ConfirmationButtons::OkCancel);
    assert_eq!(de.title, "Protium: Installation ohne Prüfsumme bestätigen");
    assert_eq!(
        de.message,
        format!(
            "Für {tag} ({tag}) wurde das exakt abgeleitete SHA512-Asset mit HTTP 404 nicht gefunden.\n\nURL: {url}\n\nMöchten Sie die unüberprüfte Installation fortsetzen?"
        )
    );

    let en = unverified_confirmation_request(tag, tag, url, DialogLocale::En);
    assert_eq!(en.kind, ConfirmationKind::Warning);
    assert_eq!(en.buttons, ConfirmationButtons::OkCancel);
    assert_eq!(en.title, "Protium: Confirm installation without a checksum");
    assert_eq!(
        en.message,
        format!(
            "The exact derived SHA512 asset for {tag} ({tag}) was not found (HTTP 404).\n\nURL: {url}\n\nDo you want to continue the unverified installation?"
        )
    );
}

#[test]
fn dialog_locale_akzeptiert_nur_de_und_en() {
    assert_eq!(parse_dialog_locale("de").unwrap(), DialogLocale::De);
    assert_eq!(parse_dialog_locale("en").unwrap(), DialogLocale::En);
    for raw in ["", "DE", "de-DE", "fr", "OK means abort"] {
        assert_eq!(
            parse_dialog_locale(raw).unwrap_err(),
            "invalid-value: locale"
        );
    }
}
