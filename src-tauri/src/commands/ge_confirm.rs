// Unverified-Bestätigung der GE-Installation (Audit 3.11): Anfrage und Dialog.

use std::future::Future;

use tauri::AppHandle;

use crate::commands::errcode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DialogLocale {
    De,
    En,
}

/// Der Webview wählt nur die Sprache. Ein anderer Wert darf keinen eigenen
/// Dialogtext einschleusen und wird nicht in die Fehlermeldung übernommen.
pub(super) fn parse_dialog_locale(raw: &str) -> Result<DialogLocale, String> {
    match raw {
        "de" => Ok(DialogLocale::De),
        "en" => Ok(DialogLocale::En),
        _ => Err(errcode::with_detail(errcode::INVALID_VALUE, "locale")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationKind {
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmationButtons {
    OkCancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UnverifiedConfirmationRequest {
    title: String,
    message: String,
    kind: ConfirmationKind,
    buttons: ConfirmationButtons,
}

fn unverified_confirmation_request(
    release_tag: &str,
    install_name: &str,
    checksum_url: &str,
    locale: DialogLocale,
) -> UnverifiedConfirmationRequest {
    let (title, message) = match locale {
        DialogLocale::De => (
            "Protium: Installation ohne Prüfsumme bestätigen",
            format!(
                "Für {release_tag} ({install_name}) wurde das exakt abgeleitete SHA512-Asset mit HTTP 404 nicht gefunden.\n\nURL: {checksum_url}\n\nMöchten Sie die unüberprüfte Installation fortsetzen?"
            ),
        ),
        DialogLocale::En => (
            "Protium: Confirm installation without a checksum",
            format!(
                "The exact derived SHA512 asset for {release_tag} ({install_name}) was not found (HTTP 404).\n\nURL: {checksum_url}\n\nDo you want to continue the unverified installation?"
            ),
        ),
    };
    UnverifiedConfirmationRequest {
        title: title.to_string(),
        message,
        kind: ConfirmationKind::Warning,
        buttons: ConfirmationButtons::OkCancel,
    }
}

pub(super) async fn confirm_unverified_installation<Fut>(
    release_tag: &str,
    install_name: &str,
    checksum_url: &str,
    locale: DialogLocale,
    show: impl FnOnce(UnverifiedConfirmationRequest) -> Fut,
) -> Result<bool, String>
where
    Fut: Future<Output = Result<bool, String>>,
{
    show(unverified_confirmation_request(
        release_tag,
        install_name,
        checksum_url,
        locale,
    ))
    .await
}

/// Dialog über den Callback von `MessageDialogBuilder::show` und ein oneshot.
/// `blocking_show` würde den Tokio-Worker blockieren; der Mutex der Umgebung
/// wird hier nicht gehalten.
pub(super) async fn show_native_unverified_confirmation(
    app: AppHandle,
    request: UnverifiedConfirmationRequest,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(request.message)
        .title(request.title)
        .kind(match request.kind {
            ConfirmationKind::Warning => MessageDialogKind::Warning,
        })
        .buttons(match request.buttons {
            ConfirmationButtons::OkCancel => MessageDialogButtons::OkCancel,
        })
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    rx.await.map_err(|_| {
        errcode::with_detail(
            errcode::UNAVAILABLE,
            "unverified installation confirmation dropped",
        )
    })
}

#[cfg(test)]
#[path = "ge_confirm_tests.rs"]
mod tests;
