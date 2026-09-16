-- =========================================================================
-- Supabase Atomic Cascade Deletion Functions (SECURITY DEFINER)
-- Ensures single-statement atomic Hard Delete across students and parent accounts
-- =========================================================================

-- 1. Atomic Cascade Deletion for Students
CREATE OR REPLACE FUNCTION public.delete_student_cascade(
    target_barcode TEXT,
    target_uuid UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    resolved_id UUID := target_uuid;
    clean_barcode TEXT := TRIM(target_barcode);
    deleted_counts JSONB;
BEGIN
    -- If UUID not supplied, attempt to resolve from students table
    IF resolved_id IS NULL AND clean_barcode IS NOT NULL AND clean_barcode <> '' THEN
        SELECT id INTO resolved_id FROM public.students 
        WHERE barcode = clean_barcode OR id::TEXT = clean_barcode
        LIMIT 1;
    END IF;

    -- Delete from all child/relational tables atomically
    DELETE FROM public.attendance_logs 
    WHERE (clean_barcode IS NOT NULL AND barcode = clean_barcode)
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.homework 
    WHERE (clean_barcode IS NOT NULL AND student_barcode = clean_barcode)
       OR (clean_barcode IS NOT NULL AND barcode = clean_barcode)
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.payments 
    WHERE (clean_barcode IS NOT NULL AND student_barcode = clean_barcode)
       OR (clean_barcode IS NOT NULL AND barcode = clean_barcode)
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.exam_grades 
    WHERE (clean_barcode IS NOT NULL AND student_barcode = clean_barcode)
       OR (clean_barcode IS NOT NULL AND barcode = clean_barcode)
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.evaluations 
    WHERE (clean_barcode IS NOT NULL AND student_barcode = clean_barcode)
       OR (clean_barcode IS NOT NULL AND barcode = clean_barcode)
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.chat_messages 
    WHERE (clean_barcode IS NOT NULL AND (barcode = clean_barcode OR chat_id = clean_barcode))
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.messages 
    WHERE (clean_barcode IS NOT NULL AND (barcode = clean_barcode OR chat_id = clean_barcode))
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.parent_accounts 
    WHERE (clean_barcode IS NOT NULL AND (student_barcode = clean_barcode OR parent_phone = clean_barcode OR id::TEXT = clean_barcode))
       OR (resolved_id IS NOT NULL AND id = resolved_id);

    DELETE FROM public.push_subscriptions
    WHERE (clean_barcode IS NOT NULL AND (student_barcode = clean_barcode OR barcode = clean_barcode))
       OR (resolved_id IS NOT NULL AND (student_id = resolved_id OR id = resolved_id));

    -- Finally delete the student record
    DELETE FROM public.students 
    WHERE (clean_barcode IS NOT NULL AND barcode = clean_barcode)
       OR (resolved_id IS NOT NULL AND id = resolved_id);

    RETURN jsonb_build_object(
        'success', true,
        'barcode', clean_barcode,
        'student_id', resolved_id
    );
END;
$$;

-- Grant execution permission to authenticated users and service role
GRANT EXECUTE ON FUNCTION public.delete_student_cascade(TEXT, UUID) TO authenticated, service_role, anon;

-- 2. Atomic Cascade Deletion for Parent Accounts
CREATE OR REPLACE FUNCTION public.delete_parent_account_cascade(
    target_barcode TEXT,
    target_uuid UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    clean_barcode TEXT := TRIM(target_barcode);
    resolved_id UUID := target_uuid;
BEGIN
    DELETE FROM public.chat_messages 
    WHERE (clean_barcode IS NOT NULL AND (barcode = clean_barcode OR chat_id = clean_barcode))
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.messages 
    WHERE (clean_barcode IS NOT NULL AND (barcode = clean_barcode OR chat_id = clean_barcode))
       OR (resolved_id IS NOT NULL AND student_id = resolved_id);

    DELETE FROM public.parent_accounts 
    WHERE (clean_barcode IS NOT NULL AND (student_barcode = clean_barcode OR parent_phone = clean_barcode OR id::TEXT = clean_barcode))
       OR (resolved_id IS NOT NULL AND id = resolved_id);

    DELETE FROM public.push_subscriptions
    WHERE (clean_barcode IS NOT NULL AND (student_barcode = clean_barcode OR barcode = clean_barcode))
       OR (resolved_id IS NOT NULL AND (student_id = resolved_id OR id = resolved_id));

    RETURN jsonb_build_object(
        'success', true,
        'barcode', clean_barcode,
        'account_id', resolved_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_parent_account_cascade(TEXT, UUID) TO authenticated, service_role, anon;
