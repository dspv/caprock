package engine

import (
	"context"
	"errors"

	"github.com/emersion/go-imap/v2/imapclient"

	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/oauth"
	"github.com/dspv/caprock/internal/mail/secrets"
)

// Credential is what signs an account in: its password, or for an OAuth
// account an access token refreshed from the stored refresh token (cached
// until a minute before it expires). refresh is the refresh token in use, ""
// for a password account. A refresh token the provider rotated is saved back.
func Credential(ctx context.Context, sec secrets.Store, a store.Account) (cred, refresh string, err error) {
	stored, err := sec.Get(a.ID)
	if err != nil {
		return "", "", err
	}
	p := oauth.ProviderOf(a.Auth)
	if p == "" {
		return stored, "", nil
	}
	access, next, err := oauth.AccessToken(ctx, p, stored)
	if err != nil {
		return "", stored, err
	}
	if next != "" && next != stored {
		_ = sec.Set(a.ID, next)
	}
	return access, next, nil
}

// Credential is the engine's view of the package function.
func (e *Engine) Credential(ctx context.Context, a store.Account) (string, error) {
	c, _, err := Credential(ctx, e.sec, a)
	return c, err
}

// forgetRefused drops the cached access token after a server refused it, so
// the next attempt asks the provider for a new one.
func forgetRefused(refresh string, err error) {
	if refresh != "" && errors.Is(err, oauth.ErrSignInAgain) {
		oauth.Forget(refresh)
	}
}

// dial connects and signs an account in with its current credential.
func (e *Engine) dial(ctx context.Context, a store.Account, h *imapclient.UnilateralDataHandler) (*imapclient.Client, string, error) {
	cred, refresh, err := Credential(ctx, e.sec, a)
	if err != nil {
		return nil, "", err
	}
	c, name, err := dialIMAP(a, cred, h)
	forgetRefused(refresh, err)
	return c, name, err
}
