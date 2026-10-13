package engine

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// Action names accepted by Apply.
const (
	ActRead    = "read"
	ActUnread  = "unread"
	ActFlag    = "flag"
	ActUnflag  = "unflag"
	ActArchive = "archive"
	ActTrash   = "trash"
	ActSpam    = "spam"
	ActNotSpam = "inbox" // move back to the inbox
	ActMove    = "move"
)

// ErrBadAction is returned for an unknown action.
var ErrBadAction = errors.New("unknown action")

// Apply performs an action on messages, which may span accounts and folders.
// targetFolder is used by ActMove.
func (e *Engine) Apply(ctx context.Context, ids []int64, action string, targetFolder int64) error {
	msgs, err := e.st.Messages(ctx, ids)
	if err != nil {
		return err
	}
	type key struct{ account, folder int64 }
	groups := map[key][]store.Message{}
	for _, m := range msgs {
		k := key{m.AccountID, m.FolderID}
		groups[k] = append(groups[k], m)
	}
	var firstErr error
	for k, ms := range groups {
		if err := e.applyGroup(ctx, k.account, k.folder, ms, action, targetFolder); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	e.notify("messages", 0)
	return firstErr
}

func (e *Engine) applyGroup(ctx context.Context, accountID, folderID int64, ms []store.Message, action string, targetFolder int64) error {
	w, err := e.worker(accountID)
	if err != nil {
		return err
	}
	src, err := e.st.Folder(ctx, folderID)
	if err != nil {
		return err
	}
	var uids imap.UIDSet
	for _, m := range ms {
		uids.AddNum(imap.UID(m.UID))
	}
	storeFlags := func(op imap.StoreFlagsOp, flag imap.Flag) error {
		return w.do(func(c *imapclient.Client, a store.Account) error {
			if _, err := c.Select(src.Name, nil).Wait(); err != nil {
				return err
			}
			return c.Store(uids, &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{flag}}, nil).Close()
		})
	}
	setLocal := func(f func(m *store.Message)) error {
		for _, m := range ms {
			f(&m)
			if err := e.st.SetFlags(ctx, m.ID, m.Seen, m.Flagged, m.Answered); err != nil {
				return err
			}
		}
		return e.st.RecountFolder(ctx, folderID)
	}
	switch action {
	case ActRead, ActUnread:
		seen := action == ActRead
		if err := setLocal(func(m *store.Message) { m.Seen = seen }); err != nil {
			return err
		}
		op := imap.StoreFlagsAdd
		if !seen {
			op = imap.StoreFlagsDel
		}
		return storeFlags(op, imap.FlagSeen)
	case ActFlag, ActUnflag:
		fl := action == ActFlag
		if err := setLocal(func(m *store.Message) { m.Flagged = fl }); err != nil {
			return err
		}
		op := imap.StoreFlagsAdd
		if !fl {
			op = imap.StoreFlagsDel
		}
		return storeFlags(op, imap.FlagFlagged)
	case ActArchive, ActTrash, ActSpam, ActNotSpam, ActMove:
		dst, err := e.target(ctx, w, accountID, action, targetFolder)
		if err != nil {
			return err
		}
		if dst.ID == src.ID {
			if action == ActTrash {
				return e.expunge(ctx, w, src, ms, uids)
			}
			return nil
		}
		err = w.do(func(c *imapclient.Client, a store.Account) error {
			if _, err := c.Select(src.Name, nil).Wait(); err != nil {
				return err
			}
			_, err := c.Move(uids, dst.Name).Wait()
			return err
		})
		if err != nil {
			return err
		}
		ids := make([]int64, len(ms))
		for i, m := range ms {
			ids[i] = m.ID
		}
		if err := e.st.DeleteMessages(ctx, ids); err != nil {
			return err
		}
		if err := e.st.RecountFolder(ctx, src.ID); err != nil {
			return err
		}
		if syncable(dst) {
			w.kickSync(dst.Name)
		}
		return nil
	}
	return ErrBadAction
}

// expunge deletes for good (trash in the trash).
func (e *Engine) expunge(ctx context.Context, w *worker, f store.Folder, ms []store.Message, uids imap.UIDSet) error {
	err := w.do(func(c *imapclient.Client, a store.Account) error {
		if _, err := c.Select(f.Name, nil).Wait(); err != nil {
			return err
		}
		if err := c.Store(uids, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
			return err
		}
		if c.Caps().Has(imap.CapUIDPlus) || c.Caps().Has(imap.CapIMAP4rev2) {
			return c.UIDExpunge(uids).Close()
		}
		return c.Expunge().Close()
	})
	if err != nil {
		return err
	}
	ids := make([]int64, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	if err := e.st.DeleteMessages(ctx, ids); err != nil {
		return err
	}
	return e.st.RecountFolder(ctx, f.ID)
}

// target resolves where a move action goes, creating an Archive folder when
// the account has none.
func (e *Engine) target(ctx context.Context, w *worker, accountID int64, action string, folderID int64) (store.Folder, error) {
	switch action {
	case ActMove:
		f, err := e.st.Folder(ctx, folderID)
		if err != nil {
			return f, err
		}
		if f.AccountID != accountID {
			return f, errors.New("cannot move between accounts")
		}
		return f, nil
	case ActTrash:
		return e.st.FolderByRole(ctx, accountID, "trash")
	case ActSpam:
		return e.st.FolderByRole(ctx, accountID, "junk")
	case ActNotSpam:
		return e.st.FolderByRole(ctx, accountID, "inbox")
	}
	// Archive: a real Archive folder, else Gmail's All Mail, else make one.
	if f, err := e.st.FolderByRole(ctx, accountID, "archive"); err == nil {
		return f, nil
	}
	if f, err := e.st.FolderByRole(ctx, accountID, "all"); err == nil {
		return f, nil
	}
	name := "Archive"
	err := w.do(func(c *imapclient.Client, a store.Account) error {
		err := c.Create(name, nil).Wait()
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "exist") {
			return fmt.Errorf("create Archive: %w", err)
		}
		return nil
	})
	if err != nil {
		return store.Folder{}, err
	}
	return e.st.UpsertFolder(ctx, accountID, name, "/", "archive")
}
