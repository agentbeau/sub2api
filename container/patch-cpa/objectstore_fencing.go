package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/sub2apiactivity"
)

// putFencedObject makes each auth/config mutation a conditional R2 write. The
// cached ETag is the version loaded at bootstrap or returned by the previous
// successful write in this process. It is intentionally not refreshed on a
// failed comparison: a stale process must not turn conflict into last-writer-wins.
func (s *ObjectTokenStore) putFencedObject(ctx context.Context, key string, data []byte, contentType string) error {
	if s == nil || s.client == nil {
		return errors.New("object store: fenced client is unavailable")
	}
	if _, ok := sub2apiactivity.FenceFromContext(ctx); !ok {
		return errors.New("object store: shared mutation has no active ownership fence")
	}
	return sub2apiactivity.RunResource(ctx, "object-write:"+key, func(writeCtx context.Context) error {
		return s.putFencedObjectWithLease(writeCtx, key, data, contentType)
	})
}

func (s *ObjectTokenStore) putFencedObjectWithLease(ctx context.Context, key string, data []byte, contentType string) error {
	objectID := sub2apiactivity.ResourceID(key)
	condition := http.Header{}
	if etag, ok := s.objectVersion(key); ok {
		condition.Set("If-Match", `"`+strings.Trim(etag, `"`)+`"`)
	} else {
		_, errStat := s.client.StatObject(ctx, s.cfg.Bucket, key, minio.StatObjectOptions{})
		if errStat == nil {
			return fmt.Errorf("object store: no loaded base version for existing object %s", objectID)
		}
		if minio.ToErrorResponse(errStat).StatusCode != http.StatusNotFound {
			return fmt.Errorf("object store: determine base version for %s: %w", objectID, errStat)
		}
		condition.Set("If-None-Match", "*")
	}

	headers := sub2apiactivity.FenceHeaders(ctx)
	if headers == nil {
		return errors.New("object store: ownership fence disappeared before write")
	}
	headers.Set("Content-Type", contentType)
	for name, values := range condition {
		headers[name] = append([]string(nil), values...)
	}
	url, errPresign := s.client.PresignHeader(ctx, http.MethodPut, s.cfg.Bucket, key, time.Minute, nil, headers)
	if errPresign != nil {
		return fmt.Errorf("object store: sign fenced write %s: %w", objectID, errPresign)
	}
	request, errRequest := http.NewRequestWithContext(ctx, http.MethodPut, url.String(), bytes.NewReader(data))
	if errRequest != nil {
		return fmt.Errorf("object store: create fenced write %s", objectID)
	}
	request.Header = headers
	response, errDo := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
	if errDo != nil {
		return fmt.Errorf("object store: conditional write outcome unknown for %s", objectID)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
	if response.StatusCode == http.StatusPreconditionFailed {
		return fmt.Errorf("object store: conditional write conflict for %s", objectID)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("object store: conditional write returned HTTP %d for %s", response.StatusCode, objectID)
	}
	etag := strings.Trim(response.Header.Get("ETag"), `"`)
	if etag == "" {
		return fmt.Errorf("object store: conditional write succeeded without an ETag; version is unknown for %s", objectID)
	}
	return s.rememberObjectVersion(key, etag)
}

func (s *ObjectTokenStore) rememberObjectVersion(key, etag string) error {
	key = strings.TrimSpace(key)
	etag = strings.Trim(etag, `"`)
	if key == "" || etag == "" {
		return errors.New("object store: loaded object has no version token")
	}
	s.objectVersionsMu.Lock()
	defer s.objectVersionsMu.Unlock()
	if s.objectVersions == nil {
		s.objectVersions = make(map[string]string)
	}
	s.objectVersions[key] = etag
	return nil
}

func (s *ObjectTokenStore) objectVersion(key string) (string, bool) {
	s.objectVersionsMu.RLock()
	defer s.objectVersionsMu.RUnlock()
	etag, ok := s.objectVersions[key]
	return etag, ok
}

// deleteFencedObject writes CPA's existing zero-byte delete marker through the
// same key-specific lease and conditional PUT used for credential/config updates.
// This preserves compatibility with existing CPA readers; R2 has no conditional
// DeleteObject operation, so physical deletion cannot safely fence a stale writer.
func (s *ObjectTokenStore) deleteFencedObject(ctx context.Context, key string) error {
	if s == nil || s.client == nil {
		return errors.New("object store: fenced client is unavailable")
	}
	if _, ok := sub2apiactivity.FenceFromContext(ctx); !ok {
		return errors.New("object store: shared delete has no active ownership fence")
	}
	if _, ok := s.objectVersion(key); !ok {
		info, errStat := s.client.StatObject(ctx, s.cfg.Bucket, key, minio.StatObjectOptions{})
		if errStat == nil {
			if errRemember := s.rememberObjectVersion(key, info.ETag); errRemember != nil {
				return errRemember
			}
		} else if minio.ToErrorResponse(errStat).StatusCode != http.StatusNotFound {
			return fmt.Errorf("object store: determine delete version for %s: %w", sub2apiactivity.ResourceID(key), errStat)
		}
	}
	return s.putFencedObject(ctx, key, []byte{}, "application/octet-stream")
}
